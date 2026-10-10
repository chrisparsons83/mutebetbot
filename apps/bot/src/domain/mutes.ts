import {
  HONOR_CALLOUT_INTERVAL_S,
  isMuteDurationKey,
  MUTE_DURATIONS,
  TOKEN_EXPIRY,
  type GuildConfig,
  type MuteKind,
  type RejoinPolicy,
  type TokenExpiryKey,
  type TokenStatus,
} from '@mutebetbot/shared';
import { addSeconds, err, ok, secondsBetween } from './result.ts';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenState {
  status: TokenStatus;
  holderId: string;
  targetId: string;
  durationS: number;
  expiresAt: Date | null;
}

/** Expiry is snapshotted at issue; `never` stores null. */
export function tokenExpiresAt(issuedAt: Date, expiry: TokenExpiryKey): Date | null {
  const s = TOKEN_EXPIRY[expiry];
  return s === null ? null : addSeconds(issuedAt, s);
}

/** Lazy expiry: an Available token past its expiry is expired even before the sweep marks it. */
export function isTokenExpired(token: Pick<TokenState, 'status' | 'expiresAt'>, now: Date): boolean {
  return token.status === 'available' && token.expiresAt !== null && token.expiresAt <= now;
}

// ---------------------------------------------------------------------------
// Admin grant
// ---------------------------------------------------------------------------

/** What the bot knows about the holder or target of a grant. */
export interface GrantMemberFacts {
  id: string;
  isBot: boolean;
  inGuild: boolean;
  /** False for admins, the owner, and anyone at or above the bot's top role. */
  mutable: boolean;
}

export interface GrantInput {
  adminId: string;
  holder: GrantMemberFacts;
  target: GrantMemberFacts;
  duration: string;
  config: GuildConfig;
  now: Date;
}

/** `/mutebet grant`: the same member and duration rules as `/bet create`, applied to holder and target. */
export function validateGrant(input: GrantInput) {
  const { adminId, holder, target, config, now } = input;
  if (!config.enabled) return err('disabled');
  if (holder.id === target.id) return err('self_grant');
  if (holder.isBot || target.isBot) return err('bot_grant');
  // Like ruling or revoking, an admin can't hand themselves a mute.
  if (holder.id === adminId) return err('grant_to_self');
  for (const m of [holder, target]) if (!m.inGuild) return err('grant_not_member', { userId: m.id });
  if (!isMuteDurationKey(input.duration) || !config.allowedDurations.includes(input.duration)) {
    return err('duration_not_allowed', { allowed: config.allowedDurations });
  }
  // Only the target can end up muted. If they can't be timed out, it becomes an honor mute unless that's off.
  if (!target.mutable && config.unmutableMembers === 'reject') return err('unmutable_target', { userId: target.id });
  return ok({ durationS: MUTE_DURATIONS[input.duration], expiresAt: tokenExpiresAt(now, config.tokenExpiry) });
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

/** What the bot learned about the target from Discord just before redeeming. */
export interface TargetFacts {
  present: boolean;
  /** False for admins, the owner, and anyone at or above the bot's top role. */
  mutable: boolean;
  /** The target's current timeout end, if any (may be a moderator's). */
  timeoutUntil: Date | null;
}

export interface RedeemInput {
  token: TokenState;
  actorId: string;
  config: GuildConfig;
  target: TargetFacts;
  /** Active timeout mutes counting toward the cap. */
  capCount: number;
  /** End of the soonest-ending active mute, for the "try again at" message. */
  soonestEnd: Date | undefined;
  targetAlreadyMuted: boolean;
  lastMuteEnd: Date | undefined;
  queue: boolean;
  now: Date;
}

export type Blocker =
  | { reason: 'at_cap'; soonestEnd: Date | undefined }
  | { reason: 'target_muted' }
  | { reason: 'target_cooldown'; eligibleAt: Date };

export function cooldownEndsAt(lastMuteEnd: Date | undefined, cooldownS: number): Date | undefined {
  return lastMuteEnd ? addSeconds(lastMuteEnd, cooldownS) : undefined;
}

/**
 * Decides what `/mute redeem` does. Rejections never spend the token.
 * Cap, already-muted, and cooldown blocks can be queued instead with `queue:true`.
 */
export function planRedemption(input: RedeemInput) {
  const { token, config, target, now } = input;
  if (token.holderId !== input.actorId) return err('not_holder');
  if (isTokenExpired(token, now)) return err('expired');
  if (token.status !== 'available') return err('not_available', { status: token.status });
  if (!config.enabled) return err('disabled');
  if (!target.present) return err('target_absent');

  const kind: MuteKind = target.mutable ? 'timeout' : 'honor';
  if (kind === 'honor' && config.unmutableMembers === 'reject') return err('target_unmutable');

  const blocker = findBlocker({
    kind,
    capCount: input.capCount,
    cap: config.maxConcurrentMutes,
    soonestEnd: input.soonestEnd,
    targetAlreadyMuted: input.targetAlreadyMuted,
    cooldownEnds: cooldownEndsAt(input.lastMuteEnd, config.targetCooldownS),
    now,
  });
  if (blocker) {
    if (input.queue) return ok({ action: 'queue' as const, blocker });
    return err('blocked', { blocker });
  }
  return ok({ action: 'mute' as const, ...planMuteStart(kind, token.durationS, target.timeoutUntil, now) });
}

function findBlocker(i: {
  kind: MuteKind;
  capCount: number;
  cap: number;
  soonestEnd: Date | undefined;
  targetAlreadyMuted: boolean;
  cooldownEnds: Date | undefined;
  now: Date;
}): Blocker | undefined {
  if (i.targetAlreadyMuted) return { reason: 'target_muted' };
  if (i.cooldownEnds && i.cooldownEnds > i.now) return { reason: 'target_cooldown', eligibleAt: i.cooldownEnds };
  // Honor mutes silence no one, so they never count toward or wait on the cap.
  if (i.kind === 'timeout' && i.capCount >= i.cap) return { reason: 'at_cap', soonestEnd: i.soonestEnd };
  return undefined;
}

/**
 * Timeout math for a starting mute. Never shortens a moderator's timeout:
 * if the existing one ends after ours, we don't write one (timeoutSetTo = null).
 */
export function planMuteStart(kind: MuteKind, durationS: number, existingTimeoutUntil: Date | null, now: Date) {
  const endsAt = addSeconds(now, durationS);
  let timeoutSetTo: Date | null = null;
  if (kind === 'timeout') {
    const existing = existingTimeoutUntil && existingTimeoutUntil > now ? existingTimeoutUntil : null;
    timeoutSetTo = existing && existing >= endsAt ? null : endsAt;
  }
  return { kind, startsAt: now, endsAt, timeoutSetTo };
}

/** Admin early lift clears the timeout only if it's still exactly the one the bot wrote. */
export function shouldClearTimeout(currentTimeoutUntil: Date | null, timeoutSetTo: Date | null): boolean {
  if (!currentTimeoutUntil || !timeoutSetTo) return false;
  // Discord may round to the second when echoing the value back.
  return Math.abs(currentTimeoutUntil.getTime() - timeoutSetTo.getTime()) < 1000;
}

// ---------------------------------------------------------------------------
// Queue promotion
// ---------------------------------------------------------------------------

export interface QueuedToken {
  id: string;
  targetId: string;
  durationS: number;
  queuedAt: Date;
}

export interface QueueTargetFacts extends TargetFacts {
  alreadyMuted: boolean;
  lastMuteEnd: Date | undefined;
}

export type PromotionDecision =
  | { tokenId: string; action: 'start'; kind: MuteKind; startsAt: Date; endsAt: Date; timeoutSetTo: Date | null }
  | { tokenId: string; action: 'return_to_holder'; reason: 'target_unmutable' };

/**
 * Starts the oldest eligible queued tokens while the cap has room. A token is skipped
 * (and stays queued) if its target is absent, in cooldown, or already muted, so one
 * blocked target can't stall everyone behind it. Only one token per target starts per pass.
 */
export function planQueuePromotion(input: {
  queue: readonly QueuedToken[];
  facts: ReadonlyMap<string, QueueTargetFacts>;
  config: GuildConfig;
  capCount: number;
  now: Date;
}): PromotionDecision[] {
  const { config, now } = input;
  let capCount = input.capCount;
  const startedTargets = new Set<string>();
  const decisions: PromotionDecision[] = [];
  const ordered = [...input.queue].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());

  for (const token of ordered) {
    const f = input.facts.get(token.targetId);
    if (!f?.present) continue;
    if (f.alreadyMuted || startedTargets.has(token.targetId)) continue;
    const cooldownEnds = cooldownEndsAt(f.lastMuteEnd, config.targetCooldownS);
    if (cooldownEnds && cooldownEnds > now) continue;

    const kind: MuteKind = f.mutable ? 'timeout' : 'honor';
    if (kind === 'honor' && config.unmutableMembers === 'reject') {
      decisions.push({ tokenId: token.id, action: 'return_to_holder', reason: 'target_unmutable' });
      continue;
    }
    if (kind === 'timeout' && capCount >= config.maxConcurrentMutes) continue;

    decisions.push({ tokenId: token.id, action: 'start', ...planMuteStart(kind, token.durationS, f.timeoutUntil, now) });
    startedTargets.add(token.targetId);
    if (kind === 'timeout') capCount++;
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Leaving mid-mute
// ---------------------------------------------------------------------------

export interface MuteTiming {
  status: 'active' | 'paused' | 'completed';
  kind: MuteKind;
  startsAt: Date;
  endsAt: Date;
  remainingS: number | null;
}

/** Target left: remember what's left and free the cap slot. */
export function planPause(mute: MuteTiming, now: Date) {
  if (mute.status !== 'active') return err('not_active');
  const remainingS = secondsBetween(now, mute.endsAt);
  if (remainingS === 0) return ok({ action: 'complete' as const });
  return ok({ action: 'pause' as const, remainingS });
}

/** Target rejoined: re-apply per policy. Resumed mutes bypass the cap (the time was already owed). */
export function planResume(mute: MuteTiming, durationS: number, policy: RejoinPolicy, timeoutUntil: Date | null, now: Date) {
  if (mute.status !== 'paused') return err('not_paused');
  const seconds = policy === 'restart_full' ? durationS : (mute.remainingS ?? 0);
  if (seconds <= 0) return ok({ action: 'complete' as const });
  // Always write a fresh timeout on rejoin; don't rely on Discord keeping the old one.
  return ok({ action: 'resume' as const, ...planMuteStart(mute.kind, seconds, timeoutUntil, now) });
}

// ---------------------------------------------------------------------------
// Scheduling and honor mutes
// ---------------------------------------------------------------------------

/** Startup: overdue mutes finalize now; the rest get a timer. */
export function partitionForStartup<T extends { endsAt: Date }>(active: readonly T[], now: Date) {
  const overdue: T[] = [];
  const schedule: T[] = [];
  for (const m of active) (m.endsAt <= now ? overdue : schedule).push(m);
  return { overdue, schedule };
}

export function shouldCallout(lastCalloutAt: Date | null, now: Date): boolean {
  return !lastCalloutAt || now.getTime() - lastCalloutAt.getTime() >= HONOR_CALLOUT_INTERVAL_S * 1000;
}

/** Node caps setTimeout at 2^31-1 ms; longer waits are re-armed in steps. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
export function timerDelayMs(endsAt: Date, now: Date): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, endsAt.getTime() - now.getTime()));
}
