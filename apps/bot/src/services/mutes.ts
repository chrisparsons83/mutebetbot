import {
  activeMuteForTarget,
  activeMutesForGuild,
  allActiveMutes,
  getBet,
  getGuild,
  getMute,
  getToken,
  guildsWithQueue,
  insertMute,
  lastMuteEnd,
  lockGuild,
  logEvent,
  openClaimsForParty,
  queuedTokens,
  runningMuteForTarget,
  setClaimRespondBy,
  toGuildConfig,
  transitionMute,
  transitionToken,
  updateMute,
  type MuteRow,
  type TokenRow,
} from '@mutebetbot/db';
import { formatDuration, type MuteKind } from '@mutebetbot/shared';
import type { Guild, GuildMember, Message, Role } from 'discord.js';
import type { App } from '../context.ts';
import { blockerText, explain, mutedLine } from '../copy.ts';
import { refreshBetMessage } from './bets.ts';
import { extendWindowForMute } from '../domain/bets.ts';
import {
  partitionForStartup,
  planPause,
  planQueuePromotion,
  planRedemption,
  planResume,
  shouldCallout,
  shouldClearTimeout,
  type Blocker,
  type QueueTargetFacts,
} from '../domain/mutes.ts';
import { fetchMember, isMutable, mention, onlyUsers, timeoutUntil, ts, tryDm, UserError } from '../discord/util.ts';
import { ensureMarkerRole } from './guild-setup.ts';
import { announce, guildOf } from './notify.ts';

const AUDIT_REASON = 'MuteBetBot: lost a bet';

function capStats(active: MuteRow[]) {
  const timeouts = active.filter((m) => m.kind === 'timeout');
  return { capCount: timeouts.length, soonestEnd: timeouts[0]?.endsAt };
}

function trackHonor(app: App, mute: Pick<MuteRow, 'guildId' | 'targetId' | 'kind'>, on: boolean) {
  if (mute.kind !== 'honor') return;
  let set = app.honorTargets.get(mute.guildId);
  if (on) {
    if (!set) app.honorTargets.set(mute.guildId, (set = new Set()));
    set.add(mute.targetId);
  } else set?.delete(mute.targetId);
}

async function addRole(app: App, member: GuildMember | null, role: Role | null) {
  if (!member || !role) return;
  // The role is cosmetic: if it fails, the mute still stands and we log a repair hint.
  await member.roles.add(role, AUDIT_REASON).catch((e: unknown) => {
    app.log.warn({ err: e, guildId: member.guild.id, userId: member.id }, 'could not add marker role; run /mutebet repair');
  });
}

async function removeRole(app: App, guild: Guild, userId: string) {
  const row = await getGuild(app.db, guild.id);
  if (!row?.markerRoleId) return;
  const member = await fetchMember(guild, userId).catch(() => null);
  if (!member?.roles.cache.has(row.markerRoleId)) return;
  await member.roles.remove(row.markerRoleId, 'MuteBetBot: bet-mute ended').catch((e: unknown) => {
    app.log.warn({ err: e, guildId: guild.id, userId }, 'could not remove marker role');
  });
}

async function applyTimeout(member: GuildMember, until: Date | null): Promise<void> {
  if (!until) return;
  try {
    await member.disableCommunicationUntil(until, AUDIT_REASON);
  } catch {
    throw new UserError(
      `I couldn't time out ${mention(member.id)}. Check that I have Moderate Members and that my role is above theirs (\`/mutebet repair\` checks both). You still have the mute.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

/** A mute that can't start right now. Carries the reason so a button can offer to wait in line. */
export class MuteBlockedError extends UserError {
  override name = 'MuteBlockedError';
  readonly blocker: Blocker;
  constructor(blocker: Blocker) {
    super(blockerText(blocker, 'command'));
    this.blocker = blocker;
  }
}

export type RedeemResult =
  | { action: 'muted'; mute: MuteRow; token: TokenRow }
  | { action: 'queued'; token: TokenRow; blocker: Blocker };

/** `/mute use` and the Mute button: lock the guild row, check cap and cooldown, spend the token, time out, add the role. */
export async function redeemToken(app: App, guild: Guild, tokenId: string, actorId: string, queue: boolean, now = new Date()): Promise<RedeemResult> {
  const initial = await getToken(app.db, tokenId);
  if (!initial) throw new UserError('That mute no longer exists.');
  // The Mute button is on a public card: turn away other members before any Discord calls.
  if (initial.holderId !== actorId) throw new UserError(explain({ error: 'not_holder' }));
  const role = await ensureMarkerRole(app, guild);
  const member = await fetchMember(guild, initial.targetId);

  const result = await app.db.transaction(async (tx): Promise<RedeemResult> => {
    const g = await lockGuild(tx, guild.id);
    if (!g) throw new UserError("This server isn't set up yet. Try `/mutebet repair`.");
    const token = (await getToken(tx, tokenId))!;
    const config = toGuildConfig(g);
    const { capCount, soonestEnd } = capStats(await activeMutesForGuild(tx, guild.id));
    const plan = planRedemption({
      token,
      actorId,
      config,
      target: { present: Boolean(member), mutable: member ? isMutable(member) : false, timeoutUntil: member ? timeoutUntil(member) : null },
      capCount,
      soonestEnd,
      targetAlreadyMuted: Boolean(await runningMuteForTarget(tx, guild.id, token.targetId)),
      lastMuteEnd: await lastMuteEnd(tx, guild.id, token.targetId),
      queue,
      now,
    });
    if (!plan.ok) {
      if (plan.error === 'blocked') throw new MuteBlockedError(plan.blocker);
      throw new UserError(explain(plan));
    }

    if (plan.action === 'queue') {
      const queued = await transitionToken(tx, token.id, 'available', 'queued', { queuedAt: now });
      if (!queued) throw new UserError('That mute was just used.');
      await logEvent(tx, { guildId: guild.id, entity: 'token', entityId: token.id, actorId, type: 'queued', payload: { reason: plan.blocker.reason } });
      return { action: 'queued', token: queued, blocker: plan.blocker };
    }

    const spent = await transitionToken(tx, token.id, 'available', 'active');
    if (!spent) throw new UserError('That mute was just used.');
    const mute = await insertMute(tx, {
      guildId: guild.id,
      tokenId: token.id,
      targetId: token.targetId,
      kind: plan.kind,
      startsAt: plan.startsAt,
      endsAt: plan.endsAt,
      timeoutSetTo: plan.timeoutSetTo,
    });
    if (!mute) throw new MuteBlockedError({ reason: 'target_muted' });
    // A failed timeout throws and rolls everything back, so the mute can still be used.
    await applyTimeout(member!, plan.timeoutSetTo);
    await logEvent(tx, {
      guildId: guild.id,
      entity: 'mute',
      entityId: mute.id,
      actorId,
      type: 'started',
      payload: { tokenId: token.id, kind: plan.kind, leftModeratorTimeout: plan.kind === 'timeout' && !plan.timeoutSetTo },
    });
    return { action: 'muted', mute, token: spent };
  });

  if (result.action === 'muted') {
    await addRole(app, member, role);
    app.scheduler.schedule(result.mute);
    trackHonor(app, result.mute, true);
  }
  await refreshBetMessage(app, initial.betId);
  return result;
}

// ---------------------------------------------------------------------------
// Queue promotion
// ---------------------------------------------------------------------------

/** Starts the oldest eligible queued tokens while the cap has room. Same lock as redemption. */
export async function promoteQueue(app: App, guildId: string, now = new Date()): Promise<void> {
  const guild = guildOf(app, guildId);
  if (!guild) return;
  const queue = await queuedTokens(app.db, guildId);
  if (!queue.length) return;
  const role = await ensureMarkerRole(app, guild);
  const members = new Map<string, GuildMember | null>();
  for (const t of queue) if (!members.has(t.targetId)) members.set(t.targetId, await fetchMember(guild, t.targetId).catch(() => null));

  const started: { mute: MuteRow; token: TokenRow }[] = [];
  const returned: TokenRow[] = [];
  await app.db.transaction(async (tx) => {
    const g = await lockGuild(tx, guildId);
    if (!g) return;
    const config = toGuildConfig(g);
    const fresh = await queuedTokens(tx, guildId);
    const facts = new Map<string, QueueTargetFacts>();
    for (const t of fresh) {
      if (facts.has(t.targetId)) continue;
      const m = members.get(t.targetId) ?? null;
      facts.set(t.targetId, {
        present: Boolean(m),
        mutable: m ? isMutable(m) : false,
        timeoutUntil: m ? timeoutUntil(m) : null,
        alreadyMuted: Boolean(await runningMuteForTarget(tx, guildId, t.targetId)),
        lastMuteEnd: await lastMuteEnd(tx, guildId, t.targetId),
      });
    }
    const { capCount } = capStats(await activeMutesForGuild(tx, guildId));
    const decisions = planQueuePromotion({
      queue: fresh.map((t) => ({ id: t.id, targetId: t.targetId, durationS: t.durationS, queuedAt: t.queuedAt ?? t.issuedAt })),
      facts,
      config,
      capCount,
      now,
    });

    for (const d of decisions) {
      if (d.action === 'return_to_holder') {
        const back = await transitionToken(tx, d.tokenId, 'queued', 'available', { queuedAt: null });
        if (back) {
          await logEvent(tx, { guildId, entity: 'token', entityId: d.tokenId, type: 'unqueued', payload: { reason: d.reason } });
          returned.push(back);
        }
        continue;
      }
      // Each start runs in a savepoint so one failed timeout doesn't undo the others.
      try {
        const res = await tx.transaction(async (sp) => {
          const token = await transitionToken(sp, d.tokenId, 'queued', 'active', { queuedAt: null });
          if (!token) return undefined;
          const mute = await insertMute(sp, {
            guildId,
            tokenId: token.id,
            targetId: token.targetId,
            kind: d.kind,
            startsAt: d.startsAt,
            endsAt: d.endsAt,
            timeoutSetTo: d.timeoutSetTo,
          });
          if (!mute) throw new Error('target already muted');
          await applyTimeout(members.get(token.targetId)!, d.timeoutSetTo);
          await logEvent(sp, { guildId, entity: 'mute', entityId: mute.id, type: 'started', payload: { tokenId: token.id, kind: d.kind, fromQueue: true } });
          return { mute, token };
        });
        if (res) started.push(res);
      } catch (e) {
        app.log.warn({ err: e, guildId, tokenId: d.tokenId }, 'could not start queued token; leaving it queued');
      }
    }
  });

  for (const { mute, token } of started) {
    await addRole(app, members.get(mute.targetId) ?? null, role);
    app.scheduler.schedule(mute);
    trackHonor(app, mute, true);
    const bet = await getBet(app.db, token.betId);
    const holder = await app.client.users.fetch(token.holderId).catch(() => null);
    if (holder) {
      await tryDm(holder, {
        content: `Your mute on ${mention(mute.targetId)} in **${guild.name}** was waiting in line and has started. They're muted until ${ts(mute.endsAt, 'f')}.`,
        allowedMentions: onlyUsers(),
      }).catch(() => null);
    }
    await announce(app, guild, bet?.channelId ?? null, {
      content: mutedLine(mute.targetId, token.holderId, mute.endsAt, mute.kind === 'honor'),
      allowedMentions: onlyUsers(mute.targetId, token.holderId),
    });
    await refreshBetMessage(app, token.betId);
  }
  for (const token of returned) {
    const holder = await app.client.users.fetch(token.holderId).catch(() => null);
    if (holder) {
      await tryDm(holder, {
        content: `Your mute on ${mention(token.targetId)} in **${guild.name}** was taken out of line because they can't be muted there right now. You still have it, and it's in \`/mute list\`.`,
        allowedMentions: onlyUsers(),
      }).catch(() => null);
    }
    await refreshBetMessage(app, token.betId);
  }
}

// ---------------------------------------------------------------------------
// Ending mutes
// ---------------------------------------------------------------------------

export type EndReason = 'expired' | 'admin' | 'moderator' | 'uninstall';

/**
 * Ends an active mute: marks it Completed, removes the role, and (except on uninstall) promotes the queue.
 * Only an admin lift or uninstall clears the timeout, and only if it's still exactly the one we wrote.
 */
export async function finalizeMute(app: App, muteId: string, reason: EndReason, liftedBy?: string, now = new Date()): Promise<MuteRow | undefined> {
  const mute = await getMute(app.db, muteId);
  if (!mute || mute.status === 'completed') return undefined;
  const guild = guildOf(app, mute.guildId);

  if ((reason === 'admin' || reason === 'uninstall') && guild && mute.kind === 'timeout') {
    const member = await fetchMember(guild, mute.targetId).catch(() => null);
    if (member && shouldClearTimeout(member.communicationDisabledUntil, mute.timeoutSetTo)) {
      await member.disableCommunicationUntil(null, 'MuteBetBot: bet-mute lifted early').catch((e: unknown) => {
        app.log.warn({ err: e, muteId }, 'could not clear timeout');
      });
    }
  }

  const endedAt = reason === 'expired' && mute.endsAt < now ? mute.endsAt : now;
  const done = await app.db.transaction(async (tx) => {
    const row = await transitionMute(tx, mute.id, ['active', 'paused'], 'completed', { completedAt: endedAt, liftedBy: liftedBy ?? null });
    if (!row) return undefined;
    await transitionToken(tx, mute.tokenId, 'active', 'completed');
    await logEvent(tx, { guildId: mute.guildId, entity: 'mute', entityId: mute.id, actorId: liftedBy ?? null, type: 'ended', payload: { reason } });
    // The confirm window doesn't run while a party is bet-muted: push open claims back by the overlap.
    for (const { claim } of await openClaimsForParty(tx, mute.guildId, mute.targetId)) {
      await setClaimRespondBy(tx, claim.id, extendWindowForMute(claim, mute.startsAt, endedAt));
    }
    return row;
  });
  if (!done) return undefined;

  app.scheduler.cancel(mute.id);
  trackHonor(app, mute, false);
  if (guild) {
    await removeRole(app, guild, mute.targetId);
    const token = await getToken(app.db, mute.tokenId);
    if (token && reason !== 'uninstall') await refreshBetMessage(app, token.betId);
    if (reason !== 'uninstall') await promoteQueue(app, mute.guildId);
  }
  return done;
}

/** `/mutebet unmute`. */
export async function adminUnmute(app: App, guildId: string, targetId: string, adminId: string): Promise<MuteRow> {
  const mute = await runningMuteForTarget(app.db, guildId, targetId);
  if (!mute) throw new UserError(`${mention(targetId)} isn't bet-muted.`);
  const token = await getToken(app.db, mute.tokenId);
  if (token && (token.holderId === adminId || token.targetId === adminId)) {
    throw new UserError("You're a party to this mute, so another admin has to lift it.");
  }
  const done = await finalizeMute(app, mute.id, 'admin', adminId);
  if (!done) throw new UserError('That mute just ended.');
  return done;
}

// ---------------------------------------------------------------------------
// Won mutes (stored as tokens)
// ---------------------------------------------------------------------------

export async function unqueueToken(app: App, token: TokenRow, actorId: string): Promise<TokenRow> {
  if (token.holderId !== actorId) throw new UserError("That isn't your mute.");
  const row = await transitionToken(app.db, token.id, 'queued', 'available', { queuedAt: null });
  if (!row) throw new UserError("That mute isn't waiting in line.");
  await logEvent(app.db, { guildId: token.guildId, entity: 'token', entityId: token.id, actorId, type: 'unqueued' });
  await refreshBetMessage(app, row.betId);
  return row;
}

export async function revokeToken(app: App, token: TokenRow, adminId: string): Promise<TokenRow> {
  if (token.holderId === adminId || token.targetId === adminId) {
    throw new UserError("You're part of this bet, so another admin has to cancel the mute.");
  }
  const row = await transitionToken(app.db, token.id, ['available', 'queued'], 'revoked', { queuedAt: null });
  if (!row) throw new UserError('Only a mute that hasn\'t been used yet can be cancelled.');
  await logEvent(app.db, { guildId: token.guildId, entity: 'token', entityId: token.id, actorId: adminId, type: 'revoked' });
  await refreshBetMessage(app, row.betId);
  return row;
}

// ---------------------------------------------------------------------------
// Leave / rejoin
// ---------------------------------------------------------------------------

/** Target left mid-mute: pause with the remaining time and free the cap slot. */
export async function onMemberLeave(app: App, guildId: string, userId: string, now = new Date()): Promise<void> {
  const mute = await activeMuteForTarget(app.db, guildId, userId);
  if (!mute) return;
  const plan = planPause(mute, now);
  if (!plan.ok) return;
  if (plan.action === 'complete') {
    await finalizeMute(app, mute.id, 'expired', undefined, now);
    return;
  }
  const paused = await transitionMute(app.db, mute.id, 'active', 'paused', { remainingS: plan.remainingS });
  if (!paused) return;
  await logEvent(app.db, { guildId, entity: 'mute', entityId: mute.id, type: 'paused', payload: { remainingS: plan.remainingS } });
  app.scheduler.cancel(mute.id);
  trackHonor(app, mute, false);
  app.log.info({ guildId, userId, remainingS: plan.remainingS }, 'muted member left; mute paused');
  const token = await getToken(app.db, mute.tokenId);
  if (token) await refreshBetMessage(app, token.betId);
  await promoteQueue(app, guildId);
}

/** Target rejoined: re-apply per rejoin_policy. Bypasses the cap; the time was already owed. */
export async function onMemberJoin(app: App, member: GuildMember, now = new Date()): Promise<void> {
  const mute = await runningMuteForTarget(app.db, member.guild.id, member.id);
  if (mute?.status !== 'paused') return;
  const [g, token] = await Promise.all([getGuild(app.db, member.guild.id), getToken(app.db, mute.tokenId)]);
  if (!g || !token) return;
  const kind: MuteKind = isMutable(member) ? 'timeout' : 'honor';
  const plan = planResume({ ...mute, kind, status: 'paused' }, token.durationS, toGuildConfig(g).rejoinPolicy, timeoutUntil(member), now);
  if (!plan.ok) return;
  if (plan.action === 'complete') {
    await finalizeMute(app, mute.id, 'expired', undefined, now);
    return;
  }
  const resumed = await transitionMute(app.db, mute.id, 'paused', 'active', {
    kind,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
    timeoutSetTo: plan.timeoutSetTo,
    remainingS: null,
  });
  if (!resumed) return;
  try {
    await applyTimeout(member, plan.timeoutSetTo);
  } catch (e) {
    app.log.warn({ err: e, guildId: member.guild.id, userId: member.id }, 'could not re-apply timeout on rejoin');
  }
  await addRole(app, member, await ensureMarkerRole(app, member.guild, g));
  await logEvent(app.db, { guildId: member.guild.id, entity: 'mute', entityId: mute.id, type: 'resumed', payload: { endsAt: plan.endsAt.toISOString() } });
  app.scheduler.schedule(resumed);
  trackHonor(app, resumed, true);
  const bet = await getBet(app.db, token.betId);
  await announce(app, member.guild, bet?.channelId ?? null, {
    content: `${mention(member.id)} is back, so their bet-mute picks up again until ${ts(plan.endsAt, 't')}.`,
    allowedMentions: onlyUsers(member.id),
  });
  await refreshBetMessage(app, token.betId);
}

// ---------------------------------------------------------------------------
// Honor mutes
// ---------------------------------------------------------------------------

/** Rate-limited public callout when an honor-muted member posts. Reads only author and channel. */
export async function onMessage(app: App, message: Message<true>, now = new Date()): Promise<void> {
  if (!app.honorTargets.get(message.guildId)?.has(message.author.id)) return;
  const mute = await activeMuteForTarget(app.db, message.guildId, message.author.id);
  if (mute?.kind !== 'honor') {
    app.honorTargets.get(message.guildId)?.delete(message.author.id);
    return;
  }
  if (!shouldCallout(mute.lastCalloutAt, now)) return;
  await updateMute(app.db, mute.id, { lastCalloutAt: now });
  const left = formatDuration((mute.endsAt.getTime() - now.getTime()) / 1000);
  await message
    .reply({ content: `${mention(message.author.id)} is on an honor mute for another ${left}.`, allowedMentions: onlyUsers(message.author.id) })
    .catch((e: unknown) => app.log.debug({ err: e }, 'honor callout failed'));
}

// ---------------------------------------------------------------------------
// Moderator lifts a timeout by hand (audit log)
// ---------------------------------------------------------------------------

export async function onTimeoutRemoved(app: App, guildId: string, targetId: string, executorId: string | null): Promise<void> {
  if (executorId === app.client.user.id) return;
  const mute = await activeMuteForTarget(app.db, guildId, targetId);
  if (mute?.kind !== 'timeout' || !mute.timeoutSetTo) return;
  app.log.info({ guildId, targetId, executorId }, 'moderator lifted a bet-mute timeout; ending it early');
  await finalizeMute(app, mute.id, 'moderator', executorId ?? undefined);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Rebuilds timers from the DB: overdue mutes finalize now, the rest are rescheduled, queues promoted. */
export async function reconcileMutes(app: App, now = new Date()): Promise<{ finalized: number; scheduled: number }> {
  const mine = (await allActiveMutes(app.db)).filter((m) => app.client.guilds.cache.has(m.guildId));
  const { overdue, schedule } = partitionForStartup(mine, now);
  for (const m of schedule) {
    app.scheduler.schedule(m);
    trackHonor(app, m, true);
  }
  for (const m of overdue) await finalizeMute(app, m.id, 'expired', undefined, now);
  for (const guildId of await guildsWithQueue(app.db)) {
    if (app.client.guilds.cache.has(guildId)) await promoteQueue(app, guildId);
  }
  return { finalized: overdue.length, scheduled: schedule.length };
}
