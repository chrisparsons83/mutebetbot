import { DEFAULT_CONFIG, type GuildConfig } from '@mutebetbot/shared';
import { describe, expect, it } from 'vitest';
import {
  claimOutcome,
  extendWindowForMute,
  planAccept,
  planAdminRule,
  planCancel,
  planClaim,
  planClaimTimeout,
  planDecline,
  planRespond,
  validateCreate,
  type BetState,
  type ClaimState,
  type CreateInput,
  type MemberFacts,
} from './bets.ts';

const NOW = new Date('2026-10-01T12:00:00Z');
const H = 3600_000;
const at = (offsetH: number) => new Date(NOW.getTime() + offsetH * H);

const A = 'challenger';
const B = 'opponent';
const ADMIN = 'admin';

const member = (id: string, over: Partial<MemberFacts> = {}): MemberFacts => ({
  id,
  isBot: false,
  inGuild: true,
  mutable: true,
  ...over,
});

const createInput = (over: Partial<CreateInput> = {}, config: Partial<GuildConfig> = {}): CreateInput => ({
  challenger: member(A),
  opponent: member(B),
  terms: 'Cowboys win Sunday',
  duration: '1h',
  config: { ...DEFAULT_CONFIG, ...config },
  openProposals: 0,
  lastCreateAt: undefined,
  now: NOW,
  ...over,
});

const bet = (over: Partial<BetState> = {}): BetState => ({
  status: 'proposed',
  challengerId: A,
  opponentId: B,
  acceptBy: at(48),
  challengerAcceptedAt: null,
  opponentAcceptedAt: null,
  ...over,
});

const claim = (over: Partial<ClaimState> = {}): ClaimState => ({
  claimantId: A,
  kind: 'win',
  createdAt: NOW,
  respondBy: at(72),
  ...over,
});

describe('validateCreate (Creating and accepting bets)', () => {
  it('accepts a valid bet with a fixed 48h acceptance window', () => {
    const r = validateCreate(createInput());
    expect(r).toEqual({ ok: true, terms: 'Cowboys win Sunday', durationS: 3600, acceptBy: at(48) });
  });

  it.each([
    ['yourself', { opponent: member(A) }, 'self_bet'],
    ['a bot', { opponent: member(B, { isBot: true }) }, 'bot_opponent'],
    ['someone not in the server', { opponent: member(B, { inGuild: false }) }, 'opponent_not_member'],
  ] as const)('rejects a bet against %s', (_label, over, error) => {
    expect(validateCreate(createInput(over))).toMatchObject({ ok: false, error });
  });

  it('caps terms length and rejects empty terms', () => {
    expect(validateCreate(createInput({ terms: 'x'.repeat(201) }))).toMatchObject({ error: 'terms_too_long' });
    expect(validateCreate(createInput({ terms: '   ' }))).toMatchObject({ error: 'terms_empty' });
  });

  it('only offers allowed durations', () => {
    expect(validateCreate(createInput({ duration: '6h' }, { allowedDurations: ['30m', '1h'] }))).toMatchObject({
      error: 'duration_not_allowed',
    });
    expect(validateCreate(createInput({ duration: '3h' }))).toMatchObject({ error: 'duration_not_allowed' });
  });

  it('throttles spam: open-proposal cap and a 30s per-user cooldown', () => {
    expect(validateCreate(createInput({ openProposals: 3 }))).toMatchObject({ error: 'too_many_proposals' });
    expect(validateCreate(createInput({ lastCreateAt: new Date(NOW.getTime() - 10_000) }))).toMatchObject({
      error: 'create_cooldown',
    });
    expect(validateCreate(createInput({ lastCreateAt: new Date(NOW.getTime() - 31_000) })).ok).toBe(true);
  });

  it('checks both parties for mutability under reject; allows honor mutes by default', () => {
    const challengerAdmin = { challenger: member(A, { mutable: false }) };
    expect(validateCreate(createInput(challengerAdmin, { unmutableMembers: 'reject' }))).toMatchObject({
      error: 'unmutable_party',
      userIds: [A],
    });
    expect(validateCreate(createInput(challengerAdmin)).ok).toBe(true);
  });

  it('allows a duplicate bet on the same terms (no dedupe)', () => {
    expect(validateCreate(createInput({ openProposals: 2 })).ok).toBe(true);
  });

  it('blocks new bets when disabled', () => {
    expect(validateCreate(createInput({}, { enabled: false }))).toMatchObject({ error: 'disabled' });
  });
});

describe('proposal buttons', () => {
  it('needs both parties, challenger included, to accept', () => {
    expect(planAccept(bet(), A, NOW)).toEqual({ ok: true, side: 'challenger', becomesActive: false });
    expect(planAccept(bet({ challengerAcceptedAt: NOW }), B, NOW)).toEqual({
      ok: true,
      side: 'opponent',
      becomesActive: true,
    });
  });

  it('ignores a repeat accept', () => {
    expect(planAccept(bet({ challengerAcceptedAt: NOW }), A, NOW)).toMatchObject({ error: 'already_accepted' });
  });

  it('tells third parties it is not their bet', () => {
    for (const plan of [planAccept, planDecline, planCancel]) {
      expect(plan(bet(), 'stranger', NOW)).toMatchObject({ error: 'not_party' });
    }
  });

  it('only the opponent declines; only the challenger cancels', () => {
    expect(planDecline(bet(), B, NOW).ok).toBe(true);
    expect(planDecline(bet(), A, NOW)).toMatchObject({ error: 'challenger_cannot_decline' });
    expect(planCancel(bet(), A, NOW).ok).toBe(true);
    expect(planCancel(bet(), B, NOW)).toMatchObject({ error: 'only_challenger_can_cancel' });
  });

  it('treats a proposal past 48h as expired even before the sweep', () => {
    expect(planAccept(bet({ acceptBy: at(-1) }), B, NOW)).toMatchObject({ error: 'expired' });
  });

  it('refuses buttons on a bet that is no longer proposed', () => {
    expect(planAccept(bet({ status: 'active' }), A, NOW)).toMatchObject({ error: 'not_proposed' });
    expect(planCancel(bet({ status: 'active' }), A, NOW)).toMatchObject({ error: 'not_proposed' });
  });
});

describe('claims (Resolving bets)', () => {
  const active = bet({ status: 'active' });
  const pending = bet({ status: 'claim_pending' });

  it('opens a claim on an active bet with the confirm window', () => {
    expect(planClaim({ bet: active, openClaim: undefined, userId: A, kind: 'win', confirmWindowS: 72 * 3600, now: NOW })).toEqual({
      ok: true,
      action: 'open',
      respondBy: at(72),
    });
  });

  it('maps "I won" / "They won" to the right winner', () => {
    expect(claimOutcome(active, { claimantId: A, kind: 'win' })).toEqual({ status: 'resolved', winnerId: A, loserId: B });
    expect(claimOutcome(active, { claimantId: A, kind: 'lose' })).toEqual({ status: 'resolved', winnerId: B, loserId: A });
    expect(claimOutcome(active, { claimantId: A, kind: 'void' })).toEqual({ status: 'void' });
  });

  it('treats both parties claiming they won as a dispute', () => {
    const r = planClaim({ bet: pending, openClaim: claim(), userId: B, kind: 'win', confirmWindowS: 1, now: NOW });
    expect(r).toMatchObject({ ok: true, action: 'dispute' });
  });

  it('treats a matching second claim as confirmation', () => {
    expect(planClaim({ bet: pending, openClaim: claim(), userId: B, kind: 'lose', confirmWindowS: 1, now: NOW })).toMatchObject({
      action: 'confirm',
      outcome: { winnerId: A },
    });
    expect(
      planClaim({ bet: pending, openClaim: claim({ kind: 'void' }), userId: B, kind: 'void', confirmWindowS: 1, now: NOW }),
    ).toMatchObject({ action: 'confirm', outcome: { status: 'void' } });
  });

  it('rejects a second claim from the same party, outsiders, and closed bets', () => {
    expect(planClaim({ bet: pending, openClaim: claim(), userId: A, kind: 'win', confirmWindowS: 1, now: NOW })).toMatchObject({
      error: 'already_claimed',
    });
    expect(planClaim({ bet: active, openClaim: undefined, userId: 'x', kind: 'win', confirmWindowS: 1, now: NOW })).toMatchObject({
      error: 'not_party',
    });
    expect(
      planClaim({ bet: bet({ status: 'resolved' }), openClaim: undefined, userId: A, kind: 'win', confirmWindowS: 1, now: NOW }),
    ).toMatchObject({ error: 'not_claimable' });
  });

  it('lets only the non-claiming party confirm or dispute', () => {
    expect(planRespond(pending, claim(), B, 'confirm')).toMatchObject({ ok: true, action: 'confirm', outcome: { winnerId: A } });
    expect(planRespond(pending, claim(), B, 'dispute')).toMatchObject({ ok: true, action: 'dispute' });
    expect(planRespond(pending, claim(), A, 'confirm')).toMatchObject({ error: 'own_claim' });
    expect(planRespond(active, undefined, B, 'confirm')).toMatchObject({ error: 'no_open_claim' });
  });

  it('a rejected void returns the bet to play instead of disputing it', () => {
    expect(planRespond(pending, claim({ kind: 'void' }), B, 'dispute')).toMatchObject({ action: 'reject_void' });
  });

  it('never auto-resolves an unanswered claim: it goes Disputed', () => {
    expect(planClaimTimeout(claim({ respondBy: at(-1) }), NOW, false)).toEqual({ action: 'dispute' });
    expect(planClaimTimeout(claim({ respondBy: at(1) }), NOW, false)).toEqual({ action: 'wait' });
    expect(planClaimTimeout(claim({ kind: 'void', respondBy: at(-1) }), NOW, false)).toEqual({ action: 'lapse_void' });
  });

  it('pauses the confirm window while a party is bet-muted', () => {
    expect(planClaimTimeout(claim({ respondBy: at(-1) }), NOW, true)).toEqual({ action: 'wait' });
    // A 2h mute fully inside the window extends it by 2h.
    expect(extendWindowForMute(claim(), at(10), at(12))).toEqual(at(74));
    // A mute that started before the claim only counts the overlap.
    expect(extendWindowForMute(claim(), at(-1), at(1))).toEqual(at(73));
    expect(extendWindowForMute(claim(), at(-3), at(-1))).toEqual(at(72));
  });
});

describe('admin ruling', () => {
  it('rules Active, ClaimPending, or Disputed bets for either party, or voids them', () => {
    for (const status of ['active', 'claim_pending', 'disputed'] as const) {
      expect(planAdminRule(bet({ status }), ADMIN, { winnerId: B })).toMatchObject({
        ok: true,
        outcome: { status: 'resolved', winnerId: B, loserId: A },
      });
    }
    expect(planAdminRule(bet({ status: 'disputed' }), ADMIN, { void: true })).toMatchObject({ outcome: { status: 'void' } });
  });

  it('refuses an admin ruling on their own bet', () => {
    expect(planAdminRule(bet({ status: 'disputed' }), A, { winnerId: A })).toMatchObject({ error: 'admin_is_party' });
  });

  it('refuses proposals, finished bets, and non-party winners', () => {
    expect(planAdminRule(bet(), ADMIN, { winnerId: A })).toMatchObject({ error: 'not_rulable' });
    expect(planAdminRule(bet({ status: 'resolved' }), ADMIN, { void: true })).toMatchObject({ error: 'not_rulable' });
    expect(planAdminRule(bet({ status: 'active' }), ADMIN, { winnerId: 'x' })).toMatchObject({ error: 'winner_not_party' });
  });

  it('still issues a token if the loser left (ruling does not depend on membership)', () => {
    expect(planAdminRule(bet({ status: 'active' }), ADMIN, { winnerId: A }).ok).toBe(true);
  });
});
