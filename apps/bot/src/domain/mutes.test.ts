import { DEFAULT_CONFIG, type GuildConfig } from '@mutebetbot/shared';
import { describe, expect, it } from 'vitest';
import { isBotAdmin, isMutableBy, type MemberAuthority } from './members.ts';
import {
  isTokenExpired,
  MAX_TIMER_MS,
  partitionForStartup,
  planMuteStart,
  planPause,
  planQueuePromotion,
  planRedemption,
  planResume,
  shouldCallout,
  shouldClearTimeout,
  timerDelayMs,
  tokenExpiresAt,
  validateGrant,
  type GrantInput,
  type MuteTiming,
  type QueueTargetFacts,
  type RedeemInput,
} from './mutes.ts';

const NOW = new Date('2026-10-01T12:00:00Z');
const H = 3600_000;
const at = (h: number) => new Date(NOW.getTime() + h * H);

const redeem = (over: Partial<RedeemInput> = {}, config: Partial<GuildConfig> = {}): RedeemInput => ({
  token: { status: 'available', holderId: 'winner', targetId: 'loser', durationS: 2 * 3600, expiresAt: at(24) },
  actorId: 'winner',
  config: { ...DEFAULT_CONFIG, ...config },
  target: { present: true, mutable: true, timeoutUntil: null },
  capCount: 0,
  soonestEnd: undefined,
  targetAlreadyMuted: false,
  lastMuteEnd: undefined,
  queue: false,
  now: NOW,
  ...over,
});

describe('tokens', () => {
  it('snapshots expiry at issue; never means null', () => {
    expect(tokenExpiresAt(NOW, '30d')).toEqual(at(30 * 24));
    expect(tokenExpiresAt(NOW, 'never')).toBeNull();
  });

  it('expires only available tokens (queued tokens wait forever)', () => {
    expect(isTokenExpired({ status: 'available', expiresAt: at(-1) }, NOW)).toBe(true);
    expect(isTokenExpired({ status: 'queued', expiresAt: at(-1) }, NOW)).toBe(false);
    expect(isTokenExpired({ status: 'available', expiresAt: null }, NOW)).toBe(false);
  });
});

describe('validateGrant (/mutebet grant)', () => {
  const member = (id: string) => ({ id, isBot: false, inGuild: true, mutable: true });
  const grant = (over: Partial<GrantInput> = {}, config: Partial<GuildConfig> = {}): GrantInput => ({
    adminId: 'admin',
    holder: member('holder'),
    target: member('target'),
    duration: '30m',
    config: { ...DEFAULT_CONFIG, ...config },
    now: NOW,
    ...over,
  });

  it('issues the duration with expiry snapshotted from config', () => {
    expect(validateGrant(grant({}, { tokenExpiry: '7d' }))).toEqual({ ok: true, durationS: 1800, expiresAt: at(7 * 24) });
    expect(validateGrant(grant({}, { tokenExpiry: 'never' }))).toMatchObject({ ok: true, expiresAt: null });
  });

  it('refuses self-targeting, bots, the granting admin as holder, and absent members', () => {
    expect(validateGrant(grant({ target: member('holder') }))).toMatchObject({ error: 'self_grant' });
    expect(validateGrant(grant({ target: { ...member('target'), isBot: true } }))).toMatchObject({ error: 'bot_grant' });
    expect(validateGrant(grant({ holder: { ...member('holder'), isBot: true } }))).toMatchObject({ error: 'bot_grant' });
    expect(validateGrant(grant({ holder: member('admin') }))).toMatchObject({ error: 'grant_to_self' });
    expect(validateGrant(grant({ target: member('admin') })).ok).toBe(true);
    expect(validateGrant(grant({ target: { ...member('target'), inGuild: false } }))).toMatchObject({ error: 'grant_not_member', userId: 'target' });
  });

  it('only allows configured durations and refuses while disabled', () => {
    expect(validateGrant(grant({ duration: '24h' }, { allowedDurations: ['30m'] }))).toMatchObject({ error: 'duration_not_allowed' });
    expect(validateGrant(grant({ duration: 'forever' }))).toMatchObject({ error: 'duration_not_allowed' });
    expect(validateGrant(grant({}, { enabled: false }))).toMatchObject({ error: 'disabled' });
  });

  it('an unmutable target is an honor mute, or refused when the server rejects those', () => {
    const target = { ...member('target'), mutable: false };
    expect(validateGrant(grant({ target }, { unmutableMembers: 'honor' })).ok).toBe(true);
    expect(validateGrant(grant({ target }, { unmutableMembers: 'reject' }))).toMatchObject({ error: 'unmutable_target' });
    // The holder is never muted, so their authority doesn't matter.
    expect(validateGrant(grant({ holder: { ...member('holder'), mutable: false } }, { unmutableMembers: 'reject' })).ok).toBe(true);
  });
});

describe('planRedemption (Redeeming and muting)', () => {
  it('mutes the loser for the token duration', () => {
    expect(planRedemption(redeem())).toEqual({
      ok: true,
      action: 'mute',
      kind: 'timeout',
      startsAt: NOW,
      endsAt: at(2),
      timeoutSetTo: at(2),
    });
  });

  it('rejects at the cap with the soonest end, keeping the token; queues with queue:true', () => {
    const atCap = { capCount: 3, soonestEnd: at(1) };
    expect(planRedemption(redeem(atCap))).toEqual({
      ok: false,
      error: 'blocked',
      blocker: { reason: 'at_cap', soonestEnd: at(1) },
    });
    expect(planRedemption(redeem({ ...atCap, queue: true }))).toMatchObject({ ok: true, action: 'queue' });
  });

  it('honours a lowered cap: running mutes stay, new ones wait', () => {
    expect(planRedemption(redeem({ capCount: 3 }, { maxConcurrentMutes: 1 }))).toMatchObject({
      blocker: { reason: 'at_cap' },
    });
  });

  it('refuses to stack mutes on an already bet-muted target', () => {
    expect(planRedemption(redeem({ targetAlreadyMuted: true }))).toMatchObject({ blocker: { reason: 'target_muted' } });
  });

  it('enforces the target cooldown with the eligible time', () => {
    expect(planRedemption(redeem({ lastMuteEnd: at(-2) }))).toMatchObject({
      blocker: { reason: 'target_cooldown', eligibleAt: at(22) },
    });
    expect(planRedemption(redeem({ lastMuteEnd: at(-25) })).ok).toBe(true);
    expect(planRedemption(redeem({ lastMuteEnd: at(-1) }, { targetCooldownS: 0 })).ok).toBe(true);
  });

  it('rejects when the target left, keeping the token', () => {
    expect(planRedemption(redeem({ target: { present: false, mutable: true, timeoutUntil: null }, queue: true }))).toMatchObject({
      error: 'target_absent',
    });
  });

  it('gives an honor mute for unmutable targets (incl. promoted since the bet); no timeout, ignores cap', () => {
    const target = { present: true, mutable: false, timeoutUntil: null };
    expect(planRedemption(redeem({ target, capCount: 3 }))).toMatchObject({ action: 'mute', kind: 'honor', timeoutSetTo: null });
    expect(planRedemption(redeem({ target }, { unmutableMembers: 'reject' }))).toMatchObject({ error: 'target_unmutable' });
  });

  it('second click sees the token is no longer available', () => {
    const token = { status: 'active' as const, holderId: 'winner', targetId: 'loser', durationS: 60, expiresAt: null };
    expect(planRedemption(redeem({ token }))).toMatchObject({ error: 'not_available' });
  });

  it('rejects non-holders, expired tokens, and a disabled server', () => {
    expect(planRedemption(redeem({ actorId: 'someone' }))).toMatchObject({ error: 'not_holder' });
    expect(planRedemption(redeem({ now: at(25) }))).toMatchObject({ error: 'expired' });
    expect(planRedemption(redeem({}, { enabled: false }))).toMatchObject({ error: 'disabled' });
  });
});

describe('never shorten a moderator timeout', () => {
  it('leaves a longer existing timeout alone but still records the mute', () => {
    expect(planMuteStart('timeout', 3600, at(5), NOW)).toEqual({ kind: 'timeout', startsAt: NOW, endsAt: at(1), timeoutSetTo: null });
  });

  it('extends a shorter existing timeout to our end', () => {
    expect(planMuteStart('timeout', 3600, new Date(NOW.getTime() + 60_000), NOW).timeoutSetTo).toEqual(at(1));
  });

  it('clears on admin lift only if the timeout is still ours', () => {
    expect(shouldClearTimeout(at(1), at(1))).toBe(true);
    expect(shouldClearTimeout(new Date(at(1).getTime() + 400), at(1))).toBe(true);
    expect(shouldClearTimeout(at(5), at(1))).toBe(false);
    expect(shouldClearTimeout(null, at(1))).toBe(false);
    expect(shouldClearTimeout(at(1), null)).toBe(false);
  });
});

describe('planQueuePromotion', () => {
  const fact = (over: Partial<QueueTargetFacts> = {}): QueueTargetFacts => ({
    present: true,
    mutable: true,
    timeoutUntil: null,
    alreadyMuted: false,
    lastMuteEnd: undefined,
    ...over,
  });
  const q = (id: string, targetId: string, minutesAgo: number) => ({
    id,
    targetId,
    durationS: 3600,
    queuedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  });

  it('starts the oldest queued token when a slot frees', () => {
    const decisions = planQueuePromotion({
      queue: [q('newer', 'x', 1), q('older', 'y', 10)],
      facts: new Map([['x', fact()], ['y', fact()]]),
      config: DEFAULT_CONFIG,
      capCount: 2,
      now: NOW,
    });
    expect(decisions.map((d) => d.tokenId)).toEqual(['older']);
  });

  it('skips blocked targets (absent, cooldown, already muted) without stalling the queue', () => {
    const decisions = planQueuePromotion({
      queue: [q('t1', 'gone', 30), q('t2', 'cooling', 20), q('t3', 'muted', 15), q('t4', 'free', 10)],
      facts: new Map([
        ['gone', fact({ present: false })],
        ['cooling', fact({ lastMuteEnd: at(-1) })],
        ['muted', fact({ alreadyMuted: true })],
        ['free', fact()],
      ]),
      config: DEFAULT_CONFIG,
      capCount: 0,
      now: NOW,
    });
    expect(decisions.map((d) => d.tokenId)).toEqual(['t4']);
  });

  it('never starts two tokens on one target in the same pass', () => {
    const decisions = planQueuePromotion({
      queue: [q('a', 'x', 10), q('b', 'x', 5)],
      facts: new Map([['x', fact()]]),
      config: DEFAULT_CONFIG,
      capCount: 0,
      now: NOW,
    });
    expect(decisions.map((d) => d.tokenId)).toEqual(['a']);
  });

  it('honor mutes start even at the cap; unmutable under reject go back to the holder', () => {
    const facts = new Map([['adm', fact({ mutable: false })]]);
    expect(planQueuePromotion({ queue: [q('h', 'adm', 1)], facts, config: DEFAULT_CONFIG, capCount: 3, now: NOW })).toMatchObject([
      { tokenId: 'h', action: 'start', kind: 'honor' },
    ]);
    expect(
      planQueuePromotion({
        queue: [q('h', 'adm', 1)],
        facts,
        config: { ...DEFAULT_CONFIG, unmutableMembers: 'reject' },
        capCount: 0,
        now: NOW,
      }),
    ).toEqual([{ tokenId: 'h', action: 'return_to_holder', reason: 'target_unmutable' }]);
  });
});

describe('leaving mid-mute', () => {
  const mute = (over: Partial<MuteTiming> = {}): MuteTiming => ({
    status: 'active',
    kind: 'timeout',
    startsAt: at(-1),
    endsAt: at(1),
    remainingS: null,
    ...over,
  });

  it('pauses with the remaining time', () => {
    expect(planPause(mute(), NOW)).toEqual({ ok: true, action: 'pause', remainingS: 3600 });
    expect(planPause(mute({ endsAt: at(-0.1) }), NOW)).toEqual({ ok: true, action: 'complete' });
  });

  it('restart_full re-applies the full duration; resume_remaining applies what was left', () => {
    const paused = mute({ status: 'paused', remainingS: 1800 });
    expect(planResume(paused, 7200, 'restart_full', null, NOW)).toMatchObject({ action: 'resume', endsAt: at(2), timeoutSetTo: at(2) });
    expect(planResume(paused, 7200, 'resume_remaining', null, NOW)).toMatchObject({ action: 'resume', endsAt: at(0.5) });
  });

  it('always writes a fresh timeout on rejoin even if Discord kept the old one', () => {
    const paused = mute({ status: 'paused', remainingS: 1800 });
    const r = planResume(paused, 7200, 'restart_full', at(0.25), NOW);
    expect(r).toMatchObject({ timeoutSetTo: at(2) });
  });
});

describe('scheduling and honor callouts', () => {
  it('finalizes overdue mutes on startup and reschedules the rest', () => {
    const { overdue, schedule } = partitionForStartup([{ endsAt: at(-1) }, { endsAt: at(1) }], NOW);
    expect(overdue).toHaveLength(1);
    expect(schedule).toHaveLength(1);
  });

  it('rate-limits callouts to one per 10 minutes', () => {
    expect(shouldCallout(null, NOW)).toBe(true);
    expect(shouldCallout(new Date(NOW.getTime() - 9 * 60_000), NOW)).toBe(false);
    expect(shouldCallout(new Date(NOW.getTime() - 10 * 60_000), NOW)).toBe(true);
  });

  it('clamps timer delays to Node limits', () => {
    expect(timerDelayMs(at(-1), NOW)).toBe(0);
    expect(timerDelayMs(at(24 * 30), NOW)).toBe(MAX_TIMER_MS);
  });
});

describe('member authority', () => {
  const m = (over: Partial<MemberAuthority> = {}): MemberAuthority => ({
    id: 'u',
    isOwner: false,
    isAdministrator: false,
    hasManageGuild: false,
    roleIds: [],
    highestRolePosition: 1,
    ...over,
  });

  it('cannot time out owners, administrators, or members at/above the bot', () => {
    expect(isMutableBy(m(), 5)).toBe(true);
    expect(isMutableBy(m({ isOwner: true }), 5)).toBe(false);
    expect(isMutableBy(m({ isAdministrator: true }), 5)).toBe(false);
    expect(isMutableBy(m({ highestRolePosition: 5 }), 5)).toBe(false);
  });

  it('admin commands need Manage Server or the admin role', () => {
    expect(isBotAdmin(m(), null)).toBe(false);
    expect(isBotAdmin(m({ hasManageGuild: true }), null)).toBe(true);
    expect(isBotAdmin(m({ roleIds: ['r1'] }), 'r1')).toBe(true);
  });
});
