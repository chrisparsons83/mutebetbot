import {
  closeClaim,
  getBet,
  getBetByMessage,
  getClaim,
  getGuild,
  getMuteForToken,
  getOpenClaim,
  getTokenForBet,
  insertClaim,
  insertToken,
  logEvent,
  overdueClaims,
  overdueProposals,
  recordAcceptance,
  runningMuteForTarget,
  setClaimDm,
  toGuildConfig,
  transitionBet,
  type BetRow,
  type ClaimRow,
  type DbOrTx,
  type TokenRow,
} from '@mutebetbot/db';
import type { ClaimKind } from '@mutebetbot/shared';
import { escapeMarkdown } from 'discord.js';
import type { App } from '../context.ts';
import { explain } from '../copy.ts';
import { otherParty, planAccept, planCancel, planClaim, planClaimTimeout, planDecline, planRespond } from '../domain/bets.ts';
import { tokenExpiresAt } from '../domain/mutes.ts';
import { renderBetMessage, renderClaimDm, type BetCardExtra } from '../discord/render.ts';
import { mention, nameOf, onlyUsers, roleMention, theBet, tryDm, UserError } from '../discord/util.ts';
import { announce, guildOf } from './notify.ts';

type Outcome = { status: 'resolved'; winnerId: string; loserId: string } | { status: 'void' };

function fail(r: { ok: false; error: string } & Record<string, unknown>): never {
  throw new UserError(explain(r));
}

/** Everything the bet card shows besides the bet row itself. */
export async function betCardExtra(app: App, bet: BetRow): Promise<BetCardExtra> {
  const [claim, token] = await Promise.all([getOpenClaim(app.db, bet.id), getTokenForBet(app.db, bet.id)]);
  const mute = token ? await getMuteForToken(app.db, token.id) : undefined;
  const guild = guildOf(app, bet.guildId);
  const loserName = guild && bet.winnerId ? nameOf(guild, otherParty(bet, bet.winnerId)) : undefined;
  return { claim, token, mute, loserName };
}

/** Re-renders the public bet message after a state change. Best-effort. */
export async function refreshBetMessage(app: App, betId: string): Promise<void> {
  const bet = await getBet(app.db, betId);
  if (!bet?.messageId) return;
  const guild = guildOf(app, bet.guildId);
  const channel = guild?.channels.cache.get(bet.channelId);
  if (!channel?.isTextBased()) return;
  const extra = await betCardExtra(app, bet);
  try {
    const message = await channel.messages.fetch(bet.messageId);
    await message.edit({ ...renderBetMessage(bet, extra), allowedMentions: onlyUsers() });
  } catch (e) {
    app.log.debug({ err: e, betId }, 'could not refresh bet message');
  }
}

// ---------------------------------------------------------------------------
// Proposal buttons
// ---------------------------------------------------------------------------

export async function acceptBet(app: App, betId: string, userId: string, now = new Date()): Promise<BetRow> {
  const bet = await getBet(app.db, betId);
  if (!bet) throw new UserError('That bet no longer exists.');
  const plan = planAccept(bet, userId, now);
  if (!plan.ok) {
    if (plan.error === 'expired') await expireProposal(app, bet);
    fail(plan);
  }
  const result = await app.db.transaction(async (tx) => {
    const updated = await recordAcceptance(tx, bet.id, plan.side, now);
    if (!updated) return fail({ ok: false, error: 'not_proposed', status: (await getBet(tx, bet.id))?.status ?? 'cancelled' });
    await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId: userId, type: 'accepted' });
    // Decide activation from the row we just wrote, so two simultaneous accepts can't both miss it.
    if (updated.challengerAcceptedAt && updated.opponentAcceptedAt) {
      const active = await transitionBet(tx, bet.id, 'proposed', 'active');
      if (active) {
        await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, type: 'activated' });
        return active;
      }
    }
    return updated;
  });
  return result;
}

export async function declineBet(app: App, betId: string, userId: string, now = new Date()): Promise<BetRow> {
  const bet = await getBet(app.db, betId);
  if (!bet) throw new UserError('That bet no longer exists.');
  const plan = planDecline(bet, userId, now);
  if (!plan.ok) fail(plan);
  return closeProposal(app, bet, 'declined', userId);
}

export async function cancelBet(app: App, bet: BetRow, userId: string, now = new Date()): Promise<BetRow> {
  const plan = planCancel(bet, userId, now);
  if (!plan.ok) fail(plan);
  return closeProposal(app, bet, 'cancelled', userId);
}

async function closeProposal(app: App, bet: BetRow, to: 'declined' | 'cancelled' | 'expired', actorId: string | null): Promise<BetRow> {
  return app.db.transaction(async (tx) => {
    const row = await transitionBet(tx, bet.id, 'proposed', to);
    if (!row) return fail({ ok: false, error: 'not_proposed', status: (await getBet(tx, bet.id))?.status ?? to });
    await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId, type: to });
    return row;
  });
}

async function expireProposal(app: App, bet: BetRow): Promise<void> {
  const row = await transitionBet(app.db, bet.id, 'proposed', 'expired');
  if (!row) return;
  await logEvent(app.db, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, type: 'expired' });
  await refreshBetMessage(app, bet.id);
}

/** A deleted proposal message cancels the bet; after acceptance the bet lives on regardless. */
export async function onBetMessageDeleted(app: App, messageId: string): Promise<void> {
  const bet = await getBetByMessage(app.db, messageId);
  if (bet?.status !== 'proposed') return;
  const row = await transitionBet(app.db, bet.id, 'proposed', 'cancelled', { messageId: null });
  if (row) {
    await logEvent(app.db, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, type: 'cancelled', payload: { reason: 'message deleted' } });
    app.log.info({ betId: bet.id }, 'proposal message deleted; bet cancelled');
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Applies a final outcome inside a transaction: Resolved issues the winner a token, Void issues nothing. */
async function applyOutcome(
  tx: DbOrTx,
  bet: BetRow,
  outcome: Outcome,
  actorId: string | null,
  now: Date,
): Promise<{ bet: BetRow; token: TokenRow | undefined }> {
  const from = ['active', 'claim_pending', 'disputed'] as const;
  if (outcome.status === 'void') {
    const row = await transitionBet(tx, bet.id, from, 'void', { resolvedBy: actorId, resolvedAt: now });
    if (!row) throw new UserError('That bet was already settled.');
    await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId, type: 'voided' });
    return { bet: row, token: undefined };
  }
  const row = await transitionBet(tx, bet.id, from, 'resolved', { winnerId: outcome.winnerId, resolvedBy: actorId, resolvedAt: now });
  if (!row) throw new UserError('That bet was already settled.');
  const guild = await getGuild(tx, bet.guildId);
  const expiry = guild ? toGuildConfig(guild).tokenExpiry : '30d';
  const token = await insertToken(tx, {
    guildId: bet.guildId,
    betId: bet.id,
    holderId: outcome.winnerId,
    targetId: outcome.loserId,
    durationS: bet.durationS,
    issuedAt: now,
    expiresAt: tokenExpiresAt(now, expiry),
  });
  await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId, type: 'resolved', payload: { winnerId: outcome.winnerId } });
  if (token) {
    await logEvent(tx, { guildId: bet.guildId, entity: 'token', entityId: token.id, actorId, type: 'issued', payload: { betId: bet.id } });
  }
  return { bet: row, token };
}

/** The ping that goes out when a bet settles. The bet card itself carries the Mute button. */
export async function announceOutcome(app: App, bet: BetRow, ruledBy?: string): Promise<void> {
  const guild = guildOf(app, bet.guildId);
  if (!guild) return;
  const which = theBet(bet.terms);
  const pair = `${mention(bet.challengerId)} and ${mention(bet.opponentId)}`;
  let content: string;
  if (bet.status === 'void') {
    content = ruledBy ? `${mention(ruledBy)} called off ${which} between ${pair}.` : `${pair} called off ${which}.`;
  } else {
    const won = `${mention(bet.winnerId!)} beat ${mention(otherParty(bet, bet.winnerId!))} on ${which}`;
    content = ruledBy ? `${mention(ruledBy)} ruled that ${won}.` : `${won}.`;
  }
  await announce(app, guild, bet.channelId, { content, allowedMentions: onlyUsers(bet.challengerId, bet.opponentId) });
}

export interface ClaimResult {
  kind: 'opened' | 'resolved' | 'disputed';
  bet: BetRow;
  claim?: ClaimRow | undefined;
  token?: TokenRow | undefined;
}

/** `/bet resolve` and `/bet void`. */
export async function submitClaim(app: App, bet: BetRow, userId: string, kind: ClaimKind, now = new Date()): Promise<ClaimResult> {
  const guildRow = await getGuild(app.db, bet.guildId);
  const config = guildRow ? toGuildConfig(guildRow) : undefined;
  const openClaim = await getOpenClaim(app.db, bet.id);
  const plan = planClaim({ bet, openClaim, userId, kind, confirmWindowS: config?.confirmWindowS ?? 72 * 3600, now });
  if (!plan.ok) fail(plan);

  if (plan.action === 'confirm') return respond(app, openClaim, bet, userId, 'confirm', undefined, now);
  if (plan.action === 'dispute') return respond(app, openClaim, bet, userId, 'dispute', 'Both sides claimed a different result', now);

  const result = await app.db.transaction(async (tx) => {
    const moved = await transitionBet(tx, bet.id, 'active', 'claim_pending');
    if (!moved) throw new UserError('Someone else just changed this bet. Try again.');
    const claim = await insertClaim(tx, { betId: bet.id, claimantId: userId, kind, respondBy: plan.respondBy, createdAt: now });
    if (!claim) throw new UserError('There is already a claim waiting on this bet.');
    await logEvent(tx, {
      guildId: bet.guildId,
      entity: 'bet',
      entityId: bet.id,
      actorId: userId,
      type: kind === 'void' ? 'void_proposed' : 'claim_opened',
      payload: { kind },
    });
    return { bet: moved, claim };
  });
  await notifyClaim(app, result.bet, result.claim);
  await refreshBetMessage(app, bet.id);
  return { kind: 'opened', ...result };
}

/** DMs the other party with Confirm / Dispute; falls back to a channel ping if their DMs are closed. */
async function notifyClaim(app: App, bet: BetRow, claim: ClaimRow): Promise<void> {
  const guild = guildOf(app, bet.guildId);
  if (!guild) return;
  const responderId = otherParty(bet, claim.claimantId);
  const user = await app.client.users.fetch(responderId).catch(() => null);
  const dm = user ? await tryDm(user, renderClaimDm(bet, claim, guild.name)).catch(() => null) : null;
  if (dm) {
    await setClaimDm(app.db, claim.id, dm.channelId, dm.id);
    return;
  }
  const what = claim.kind === 'void' ? 'wants to call off' : claim.kind === 'win' ? 'says they won' : 'says you won';
  await announce(app, guild, bet.channelId, {
    content: `${mention(responderId)}, ${mention(claim.claimantId)} ${what} ${theBet(bet.terms)}. I couldn't DM you, so answer with \`/bet confirm\` or \`/bet dispute\`.`,
    allowedMentions: onlyUsers(responderId),
  });
}

/** Disables the DM buttons once a claim is answered or overtaken. */
async function closeClaimDm(app: App, bet: BetRow, claim: ClaimRow, note: string): Promise<void> {
  if (!claim.dmChannelId || !claim.dmMessageId) return;
  try {
    const channel = await app.client.channels.fetch(claim.dmChannelId);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(claim.dmMessageId);
    const guildName = guildOf(app, bet.guildId)?.name ?? 'the server';
    const { embeds, components } = renderClaimDm(bet, claim, guildName, note);
    await message.edit({ embeds, components });
  } catch (e) {
    app.log.debug({ err: e, claimId: claim.id }, 'could not update claim DM');
  }
}

/** Confirm / dispute from `/bet confirm`, `/bet dispute`, or the DM buttons. */
export async function respondToClaim(
  app: App,
  bet: BetRow,
  userId: string,
  response: 'confirm' | 'dispute',
  reason?: string,
  claimId?: string,
  now = new Date(),
): Promise<ClaimResult> {
  const claim = claimId ? await getClaim(app.db, claimId) : await getOpenClaim(app.db, bet.id);
  if (claimId && claim?.status !== 'open') throw new UserError('That claim has already been answered.');
  return respond(app, claim, bet, userId, response, reason, now);
}

async function respond(
  app: App,
  claim: ClaimRow | undefined,
  bet: BetRow,
  userId: string,
  response: 'confirm' | 'dispute',
  reason: string | undefined,
  now: Date,
): Promise<ClaimResult> {
  const plan = planRespond(bet, claim, userId, response);
  if (!plan.ok) fail(plan);
  const open = claim!;

  if (plan.action === 'confirm') {
    const result = await app.db.transaction(async (tx) => {
      const closed = await closeClaim(tx, open.id, 'confirmed', { responderId: userId, respondedAt: now });
      if (!closed) throw new UserError('That claim has already been answered.');
      await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId: userId, type: 'confirmed' });
      return applyOutcome(tx, bet, plan.outcome, null, now);
    });
    await closeClaimDm(app, bet, open, 'Confirmed.');
    await refreshBetMessage(app, bet.id);
    await announceOutcome(app, result.bet);
    return { kind: 'resolved', ...result };
  }

  if (plan.action === 'reject_void') {
    const row = await app.db.transaction(async (tx) => {
      const closed = await closeClaim(tx, open.id, 'disputed', { responderId: userId, respondedAt: now, reason: reason ?? null });
      if (!closed) throw new UserError('That claim has already been answered.');
      const back = await transitionBet(tx, bet.id, 'claim_pending', 'active');
      await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId: userId, type: 'void_rejected', payload: { reason } });
      return back ?? bet;
    });
    await closeClaimDm(app, bet, open, 'The bet stays on.');
    await refreshBetMessage(app, bet.id);
    return { kind: 'opened', bet: row };
  }

  const row = await app.db.transaction(async (tx) => {
    const closed = await closeClaim(tx, open.id, 'disputed', { responderId: userId, respondedAt: now, reason: reason ?? null });
    if (!closed) throw new UserError('That claim has already been answered.');
    const disputed = await transitionBet(tx, bet.id, 'claim_pending', 'disputed');
    await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId: userId, type: 'disputed', payload: { reason } });
    return disputed ?? bet;
  });
  await closeClaimDm(app, bet, open, 'Disputed. An admin will decide.');
  await refreshBetMessage(app, bet.id);
  await notifyAdminsOfDispute(app, row, reason);
  return { kind: 'disputed', bet: row };
}

async function notifyAdminsOfDispute(app: App, bet: BetRow, reason: string | undefined): Promise<void> {
  const guild = guildOf(app, bet.guildId);
  if (!guild) return;
  const row = await getGuild(app.db, bet.guildId);
  const adminRole = row ? toGuildConfig(row).adminRoleId : null;
  const who = adminRole ? roleMention(adminRole) : 'Admins';
  await announce(app, guild, bet.channelId, {
    content:
      `${who}, ${mention(bet.challengerId)} and ${mention(bet.opponentId)} disagree on ${theBet(bet.terms)}.` +
      `${reason ? ` The reason given was "${escapeMarkdown(reason.slice(0, 200))}".` : ''} Decide it with \`/mutebet rule\`.`,
    allowedMentions: { parse: [], users: [], roles: adminRole ? [adminRole] : [] },
  });
}

/** `/mutebet rule`: resolves or voids immediately; any open claim is superseded. */
export async function adminRule(app: App, bet: BetRow, adminId: string, outcome: Outcome, now = new Date()) {
  const open = await getOpenClaim(app.db, bet.id);
  const result = await app.db.transaction(async (tx) => {
    if (open) await closeClaim(tx, open.id, 'superseded', { responderId: adminId, respondedAt: now });
    await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, actorId: adminId, type: 'ruled', payload: { outcome: outcome.status } });
    return applyOutcome(tx, bet, outcome, adminId, now);
  });
  if (open) await closeClaimDm(app, bet, open, 'An admin ruled on this bet.');
  await refreshBetMessage(app, bet.id);
  await announceOutcome(app, result.bet, adminId);
  return result;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export async function sweepProposals(app: App, now = new Date()): Promise<number> {
  const overdue = await overdueProposals(app.db, now);
  for (const bet of overdue) await expireProposal(app, bet);
  return overdue.length;
}

/** Unanswered claims go Disputed (void proposals lapse). The window pauses while a party is bet-muted. */
export async function sweepClaims(app: App, now = new Date()): Promise<number> {
  let n = 0;
  for (const { claim, bet } of await overdueClaims(app.db, now)) {
    const muted = await Promise.all([bet.challengerId, bet.opponentId].map((id) => runningMuteForTarget(app.db, bet.guildId, id)));
    const plan = planClaimTimeout(claim, now, muted.some((m) => m?.status === 'active'));
    if (plan.action === 'wait') continue;
    const lapse = plan.action === 'lapse_void';
    const moved = await app.db.transaction(async (tx) => {
      const closed = await closeClaim(tx, claim.id, lapse ? 'lapsed' : 'disputed', { respondedAt: now });
      if (!closed) return undefined;
      const row = await transitionBet(tx, bet.id, 'claim_pending', lapse ? 'active' : 'disputed');
      await logEvent(tx, { guildId: bet.guildId, entity: 'bet', entityId: bet.id, type: lapse ? 'void_lapsed' : 'claim_timed_out' });
      return row;
    });
    if (!moved) continue;
    n++;
    await closeClaimDm(app, bet, claim, lapse ? 'No answer, so the bet stays on.' : 'No answer in time, so an admin will decide.');
    await refreshBetMessage(app, bet.id);
    if (!lapse) await notifyAdminsOfDispute(app, moved, 'No answer within the confirm window');
  }
  return n;
}

