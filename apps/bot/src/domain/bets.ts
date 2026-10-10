import {
  CREATE_COOLDOWN_S,
  isMuteDurationKey,
  MUTE_DURATIONS,
  PROPOSAL_TTL_S,
  TERMS_MAX_LENGTH,
  type BetStatus,
  type ClaimKind,
  type GuildConfig,
} from '@mutebetbot/shared';
import { addSeconds, err, ok } from './result.ts';

/** The fields of a bet the rules need. Matches the DB row shape. */
export interface BetState {
  status: BetStatus;
  challengerId: string;
  opponentId: string;
  acceptBy: Date;
  challengerAcceptedAt: Date | null;
  opponentAcceptedAt: Date | null;
}

export interface ClaimState {
  claimantId: string;
  kind: ClaimKind;
  createdAt: Date;
  respondBy: Date;
}

export interface MemberFacts {
  id: string;
  isBot: boolean;
  inGuild: boolean;
  /** False for admins, the owner, and anyone at or above the bot's top role. */
  mutable: boolean;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateInput {
  challenger: MemberFacts;
  opponent: MemberFacts;
  terms: string;
  duration: string;
  config: GuildConfig;
  openProposals: number;
  lastCreateAt: Date | undefined;
  now: Date;
}

export function validateCreate(input: CreateInput) {
  const { challenger, opponent, config, now } = input;
  if (!config.enabled) return err('disabled');
  if (opponent.id === challenger.id) return err('self_bet');
  if (opponent.isBot) return err('bot_opponent');
  if (!opponent.inGuild) return err('opponent_not_member');
  const terms = input.terms.trim();
  if (!terms) return err('terms_empty');
  if (terms.length > TERMS_MAX_LENGTH) return err('terms_too_long', { max: TERMS_MAX_LENGTH });
  if (!isMuteDurationKey(input.duration) || !config.allowedDurations.includes(input.duration)) {
    return err('duration_not_allowed', { allowed: config.allowedDurations });
  }
  if (input.lastCreateAt) {
    const retryAt = addSeconds(input.lastCreateAt, CREATE_COOLDOWN_S);
    if (retryAt > now) return err('create_cooldown', { retryAt });
  }
  if (input.openProposals >= config.maxOpenProposalsPerUser) {
    return err('too_many_proposals', { max: config.maxOpenProposalsPerUser });
  }
  // Either side could lose, so both must be mutable unless honor mutes are allowed.
  if (config.unmutableMembers === 'reject') {
    const unmutable = [challenger, opponent].filter((m) => !m.mutable).map((m) => m.id);
    if (unmutable.length) return err('unmutable_party', { userIds: unmutable });
  }
  return ok({
    terms,
    durationS: MUTE_DURATIONS[input.duration],
    acceptBy: addSeconds(now, PROPOSAL_TTL_S),
  });
}

// ---------------------------------------------------------------------------
// Proposal buttons
// ---------------------------------------------------------------------------

export type Party = 'challenger' | 'opponent';

export function partyOf(bet: Pick<BetState, 'challengerId' | 'opponentId'>, userId: string): Party | undefined {
  if (userId === bet.challengerId) return 'challenger';
  if (userId === bet.opponentId) return 'opponent';
  return undefined;
}

export function otherParty(bet: Pick<BetState, 'challengerId' | 'opponentId'>, userId: string): string {
  return userId === bet.challengerId ? bet.opponentId : bet.challengerId;
}

/** Lazy expiry: a Proposed bet past its window is treated as Expired even before the sweep runs. */
export function isProposalExpired(bet: Pick<BetState, 'status' | 'acceptBy'>, now: Date): boolean {
  return bet.status === 'proposed' && bet.acceptBy <= now;
}

export function planAccept(bet: BetState, userId: string, now: Date) {
  const side = partyOf(bet, userId);
  if (!side) return err('not_party');
  if (isProposalExpired(bet, now)) return err('expired');
  if (bet.status !== 'proposed') return err('not_proposed', { status: bet.status });
  const already = side === 'challenger' ? bet.challengerAcceptedAt : bet.opponentAcceptedAt;
  if (already) return err('already_accepted');
  const otherAccepted = side === 'challenger' ? bet.opponentAcceptedAt : bet.challengerAcceptedAt;
  return ok({ side, becomesActive: otherAccepted !== null });
}

export function planDecline(bet: BetState, userId: string, now: Date) {
  const side = partyOf(bet, userId);
  if (!side) return err('not_party');
  if (side !== 'opponent') return err('challenger_cannot_decline');
  if (isProposalExpired(bet, now)) return err('expired');
  if (bet.status !== 'proposed') return err('not_proposed', { status: bet.status });
  return ok({});
}

export function planCancel(bet: BetState, userId: string, now: Date) {
  const side = partyOf(bet, userId);
  if (!side) return err('not_party');
  if (side !== 'challenger') return err('only_challenger_can_cancel');
  if (isProposalExpired(bet, now)) return err('expired');
  if (bet.status !== 'proposed') return err('not_proposed', { status: bet.status });
  return ok({});
}

// ---------------------------------------------------------------------------
// Claims: resolve ("I won" / "They won") and void
// ---------------------------------------------------------------------------

/** What a confirmed claim does to the bet. */
export function claimOutcome(
  bet: Pick<BetState, 'challengerId' | 'opponentId'>,
  claim: Pick<ClaimState, 'claimantId' | 'kind'>,
): { status: 'resolved'; winnerId: string; loserId: string } | { status: 'void' } {
  if (claim.kind === 'void') return { status: 'void' };
  const winnerId = claim.kind === 'win' ? claim.claimantId : otherParty(bet, claim.claimantId);
  return { status: 'resolved', winnerId, loserId: otherParty(bet, winnerId) };
}

/** Whether two claims about the same bet say the same thing. */
export function claimsAgree(bet: Pick<BetState, 'challengerId' | 'opponentId'>, a: Pick<ClaimState, 'claimantId' | 'kind'>, b: Pick<ClaimState, 'claimantId' | 'kind'>): boolean {
  const oa = claimOutcome(bet, a);
  const ob = claimOutcome(bet, b);
  if (oa.status === 'void' || ob.status === 'void') return oa.status === ob.status;
  return ob.status === 'resolved' && oa.winnerId === ob.winnerId;
}

export interface ClaimInput {
  bet: BetState;
  openClaim: ClaimState | undefined;
  userId: string;
  kind: ClaimKind;
  confirmWindowS: number;
  now: Date;
}

/**
 * A party claims a result or proposes a void.
 * - On an Active bet: opens a claim and the bet goes ClaimPending.
 * - If the other party already has an open claim: a matching claim counts as confirming it;
 *   a conflicting one (e.g. both say "I won") is a dispute.
 */
export function planClaim(input: ClaimInput) {
  const { bet, openClaim, userId, kind, now } = input;
  if (!partyOf(bet, userId)) return err('not_party');
  if (bet.status === 'active') {
    return ok({ action: 'open' as const, respondBy: addSeconds(now, input.confirmWindowS) });
  }
  if (bet.status === 'claim_pending' && openClaim) {
    if (openClaim.claimantId === userId) return err('already_claimed');
    const mine = { claimantId: userId, kind };
    if (claimsAgree(bet, openClaim, mine)) {
      return ok({ action: 'confirm' as const, outcome: claimOutcome(bet, openClaim) });
    }
    return ok({ action: 'dispute' as const, reason: 'conflicting_claim' });
  }
  return err('not_claimable', { status: bet.status });
}

/** The non-claiming party confirms or disputes an open claim (slash command or DM button). */
export function planRespond(bet: BetState, claim: ClaimState | undefined, userId: string, response: 'confirm' | 'dispute') {
  if (!partyOf(bet, userId)) return err('not_party');
  if (bet.status !== 'claim_pending' || !claim) return err('no_open_claim', { status: bet.status });
  if (claim.claimantId === userId) return err('own_claim');
  if (response === 'confirm') return ok({ action: 'confirm' as const, outcome: claimOutcome(bet, claim) });
  // A rejected void just means the bet carries on; a disputed result needs an admin.
  if (claim.kind === 'void') return ok({ action: 'reject_void' as const });
  return ok({ action: 'dispute' as const });
}

/**
 * Unanswered claims: a result claim goes Disputed (never auto-resolves for the claimant);
 * an unanswered void proposal lapses and the bet returns to Active.
 * The window doesn't run while either party is bet-muted.
 */
export function planClaimTimeout(claim: ClaimState, now: Date, anyPartyMuted: boolean) {
  if (claim.respondBy > now) return { action: 'wait' as const };
  if (anyPartyMuted) return { action: 'wait' as const };
  return claim.kind === 'void' ? { action: 'lapse_void' as const } : { action: 'dispute' as const };
}

/** Extends a claim's window by the part of a finished mute that overlapped it (the window pauses). */
export function extendWindowForMute(claim: Pick<ClaimState, 'createdAt' | 'respondBy'>, muteStart: Date, muteEnd: Date): Date {
  const overlapStart = Math.max(claim.createdAt.getTime(), muteStart.getTime());
  const overlapEnd = Math.min(claim.respondBy.getTime(), muteEnd.getTime());
  const overlap = Math.max(0, overlapEnd - overlapStart);
  return new Date(claim.respondBy.getTime() + overlap);
}

// ---------------------------------------------------------------------------
// Admin ruling
// ---------------------------------------------------------------------------

export function planAdminRule(bet: BetState, adminId: string, ruling: { winnerId: string } | { void: true }) {
  if (partyOf(bet, adminId)) return err('admin_is_party');
  if (!(['active', 'claim_pending', 'disputed'] as BetStatus[]).includes(bet.status)) {
    return err('not_rulable', { status: bet.status });
  }
  if ('void' in ruling) return ok({ outcome: { status: 'void' as const } });
  if (!partyOf(bet, ruling.winnerId)) return err('winner_not_party');
  return ok({
    outcome: { status: 'resolved' as const, winnerId: ruling.winnerId, loserId: otherParty(bet, ruling.winnerId) },
  });
}
