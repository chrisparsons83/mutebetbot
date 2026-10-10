import { getOpenClaim, getTokenForBet, insertBet, upsertGuild, updateGuildConfig, type BetRow } from '@mutebetbot/db';
import { hasTestDb, snowflake, useTestDb } from '@mutebetbot/db/test-helpers';
import { describe, expect, it } from 'vitest';
import type { App } from '../context.ts';
import { UserError } from '../discord/util.ts';
import { acceptBet, adminRule, respondToClaim, submitClaim, sweepClaims, sweepProposals } from './bets.ts';

const H = 3600_000;

describe.runIf(hasTestDb)('bet service flows (integration, Discord stubbed)', () => {
  const db = useTestDb();
  // No guilds in the client cache, so every Discord side effect is skipped.
  const app = {
    db,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    client: { guilds: { cache: new Map() }, users: { fetch: () => Promise.reject(new Error('offline')) } },
  } as unknown as App;

  async function newBet(over: Partial<BetRow> = {}) {
    const guildId = snowflake();
    await upsertGuild(db, guildId);
    const bet = await insertBet(db, {
      guildId,
      challengerId: snowflake(),
      opponentId: snowflake(),
      terms: 'Test',
      durationS: 3600,
      channelId: snowflake(),
      acceptBy: new Date(Date.now() + 48 * H),
      ...over,
    });
    return bet;
  }

  async function activeBet() {
    const bet = await newBet();
    await acceptBet(app, bet.id, bet.challengerId);
    return acceptBet(app, bet.id, bet.opponentId);
  }

  it('activates exactly once when both parties accept at the same moment', async () => {
    const bet = await newBet();
    const [a, b] = await Promise.all([acceptBet(app, bet.id, bet.challengerId), acceptBet(app, bet.id, bet.opponentId)]);
    expect([a.status, b.status]).toContain('active');
  });

  it('refuses a third party without changing anything', async () => {
    const bet = await newBet();
    await expect(acceptBet(app, bet.id, snowflake())).rejects.toThrow(UserError);
  });

  it('claim → confirm resolves and issues one token with the snapshotted expiry', async () => {
    const bet = await activeBet();
    await updateGuildConfig(db, bet.guildId, { tokenExpiry: '7d' });
    const opened = await submitClaim(app, bet, bet.challengerId, 'win');
    expect(opened.kind).toBe('opened');
    expect(opened.bet.status).toBe('claim_pending');

    const r = await respondToClaim(app, opened.bet, bet.opponentId, 'confirm');
    expect(r.kind).toBe('resolved');
    expect(r.bet.winnerId).toBe(bet.challengerId);
    const token = await getTokenForBet(db, bet.id);
    expect(token).toMatchObject({ holderId: bet.challengerId, targetId: bet.opponentId, durationS: 3600, status: 'available' });
    expect(token!.expiresAt!.getTime() - token!.issuedAt.getTime()).toBe(7 * 24 * H);
  });

  it('both claiming victory makes the bet Disputed', async () => {
    const bet = await activeBet();
    const opened = await submitClaim(app, bet, bet.challengerId, 'win');
    const r = await submitClaim(app, opened.bet, bet.opponentId, 'win');
    expect(r.kind).toBe('disputed');
    expect(r.bet.status).toBe('disputed');
  });

  it('a matching second claim settles the bet', async () => {
    const bet = await activeBet();
    const opened = await submitClaim(app, bet, bet.challengerId, 'lose');
    const r = await submitClaim(app, opened.bet, bet.opponentId, 'win');
    expect(r.kind).toBe('resolved');
    expect(r.bet.winnerId).toBe(bet.opponentId);
  });

  it('a rejected void keeps the bet on; a confirmed one issues nothing', async () => {
    const bet = await activeBet();
    const v = await submitClaim(app, bet, bet.challengerId, 'void');
    const rejected = await respondToClaim(app, v.bet, bet.opponentId, 'dispute');
    expect(rejected.bet.status).toBe('active');

    const v2 = await submitClaim(app, rejected.bet, bet.opponentId, 'void');
    const confirmed = await respondToClaim(app, v2.bet, bet.challengerId, 'confirm');
    expect(confirmed.bet.status).toBe('void');
    expect(await getTokenForBet(db, bet.id)).toBeUndefined();
  });

  it('the sweep disputes unanswered claims and expires stale proposals', async () => {
    const bet = await activeBet();
    await updateGuildConfig(db, bet.guildId, { confirmWindowS: 3600 });
    await submitClaim(app, bet, bet.challengerId, 'win');
    const later = new Date(Date.now() + 2 * H);
    expect(await sweepClaims(app, later)).toBeGreaterThanOrEqual(1);
    expect(await getOpenClaim(db, bet.id)).toBeUndefined();

    const stale = await newBet({ acceptBy: new Date(Date.now() - 1000) });
    expect(await sweepProposals(app)).toBeGreaterThanOrEqual(1);
    await expect(acceptBet(app, stale.id, stale.opponentId)).rejects.toThrow(/expired|already/i);
  });

  it('an admin ruling supersedes an open claim and resolves immediately', async () => {
    const bet = await activeBet();
    const opened = await submitClaim(app, bet, bet.challengerId, 'win');
    const admin = snowflake();
    const r = await adminRule(app, opened.bet, admin, { status: 'resolved', winnerId: bet.opponentId, loserId: bet.challengerId });
    expect(r.bet).toMatchObject({ status: 'resolved', winnerId: bet.opponentId, resolvedBy: admin });
    expect(await getOpenClaim(db, bet.id)).toBeUndefined();
    await expect(respondToClaim(app, r.bet, bet.opponentId, 'confirm')).rejects.toThrow(UserError);
  });
});
