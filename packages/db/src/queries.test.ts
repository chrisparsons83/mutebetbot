import { describe, expect, it } from 'vitest';
import {
  countCapMutes,
  countProposedByChallenger,
  expireTokens,
  getGuild,
  insertBet,
  insertClaim,
  insertMute,
  insertToken,
  lastMuteEnd,
  listWonMutes,
  lockGuild,
  markGuildRemoved,
  purgeRemovedGuilds,
  queuedTokens,
  recordAcceptance,
  searchBets,
  toGuildConfig,
  transitionBet,
  transitionMute,
  transitionToken,
  upsertGuild,
} from './index.ts';
import { DEFAULT_CONFIG } from '@mutebetbot/shared';
import { hasTestDb, snowflake, useTestDb } from './test/helpers.ts';

const HOUR = 3600_000;

describe.runIf(hasTestDb)('db queries (integration)', () => {
  const db = useTestDb();

  async function setup() {
    const guildId = snowflake();
    const a = snowflake();
    const b = snowflake();
    await upsertGuild(db, guildId);
    const bet = await insertBet(db, {
      guildId,
      challengerId: a,
      opponentId: b,
      terms: 'Rain tomorrow',
      durationS: 3600,
      channelId: snowflake(),
      acceptBy: new Date(Date.now() + 48 * HOUR),
    });
    return { guildId, a, b, bet };
  }

  it('searches bets by short ID prefix, terms, or party', async () => {
    const { guildId, a, bet } = await setup();
    const ids = async (query: string, userIds: string[] = []) => (await searchBets(db, guildId, { query, userIds })).map((b) => b.id);
    expect(await ids(bet.shortId.slice(0, 2))).toEqual([bet.id]);
    expect(await ids('rain')).toEqual([bet.id]);
    expect(await ids('snow')).toEqual([]);
    expect(await ids('parsons', [a])).toEqual([bet.id]);
    expect(await ids('')).toEqual([bet.id]);
  });

  it('lists won mutes with their bets', async () => {
    const { guildId, a, b, bet } = await setup();
    await insertToken(db, { guildId, betId: bet.id, holderId: a, targetId: b, durationS: 3600, issuedAt: new Date(), expiresAt: null });
    const rows = await listWonMutes(db, guildId, { holderId: a, statuses: ['available'] });
    expect(rows.map((r) => [r.bet.terms, r.token.targetId])).toEqual([['Rain tomorrow', b]]);
    expect(await listWonMutes(db, guildId, { holderId: b, statuses: ['available'] })).toEqual([]);
  });

  it('creates guilds with the default config and revives soft-deleted ones', async () => {
    const id = snowflake();
    const row = await upsertGuild(db, id);
    expect(toGuildConfig(row)).toEqual(DEFAULT_CONFIG);
    await markGuildRemoved(db, id, new Date(Date.now() - 31 * 24 * HOUR));
    expect((await upsertGuild(db, id)).removedAt).toBeNull();
  });

  it('purges guilds removed more than 30 days ago, cascading their data', async () => {
    const { guildId, bet } = await setup();
    await markGuildRemoved(db, guildId, new Date(Date.now() - 31 * 24 * HOUR));
    const purged = await purgeRemovedGuilds(db, new Date(Date.now() - 30 * 24 * HOUR));
    expect(purged).toContain(guildId);
    expect(await getGuild(db, guildId)).toBeUndefined();
    expect(await transitionBet(db, bet.id, 'proposed', 'cancelled')).toBeUndefined();
  });

  it('gives bets B-prefixed short IDs and counts proposals per challenger', async () => {
    const { guildId, a, bet } = await setup();
    expect(bet.shortId).toMatch(/^B[2-9A-Z]{3}$/);
    expect(bet.status).toBe('proposed');
    expect(await countProposedByChallenger(db, guildId, a)).toBe(1);
  });

  it('applies a guarded transition exactly once', async () => {
    const { bet } = await setup();
    const results = await Promise.all([
      transitionBet(db, bet.id, 'proposed', 'cancelled'),
      transitionBet(db, bet.id, 'proposed', 'declined'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('records acceptance only while proposed', async () => {
    const { bet } = await setup();
    expect((await recordAcceptance(db, bet.id, 'opponent', new Date()))?.opponentAcceptedAt).toBeInstanceOf(Date);
    await transitionBet(db, bet.id, 'proposed', 'expired');
    expect(await recordAcceptance(db, bet.id, 'challenger', new Date())).toBeUndefined();
  });

  it('allows at most one open claim per bet', async () => {
    const { a, b, bet } = await setup();
    const respondBy = new Date(Date.now() + HOUR);
    expect(await insertClaim(db, { betId: bet.id, claimantId: a, kind: 'win', respondBy })).toBeDefined();
    expect(await insertClaim(db, { betId: bet.id, claimantId: b, kind: 'win', respondBy })).toBeUndefined();
  });

  it('issues at most one token per bet', async () => {
    const { guildId, a, b, bet } = await setup();
    const values = { guildId, betId: bet.id, holderId: a, targetId: b, durationS: 3600, expiresAt: null };
    const token = await insertToken(db, values);
    expect(token?.shortId).toMatch(/^T/);
    expect(await insertToken(db, values)).toBeUndefined();
  });

  it('expires available tokens but never queued ones', async () => {
    const { guildId, a, b, bet } = await setup();
    const past = new Date(Date.now() - HOUR);
    const t1 = (await insertToken(db, { guildId, betId: bet.id, holderId: a, targetId: b, durationS: 60, expiresAt: past }))!;
    const { bet: bet2 } = await setup();
    const t2 = (await insertToken(db, { guildId, betId: bet2.id, holderId: a, targetId: b, durationS: 60, expiresAt: past }))!;
    await transitionToken(db, t2.id, 'available', 'queued', { queuedAt: new Date() });
    const expired = (await expireTokens(db, new Date())).map((t) => t.id);
    expect(expired).toContain(t1.id);
    expect(expired).not.toContain(t2.id);
    expect((await queuedTokens(db, guildId)).map((t) => t.id)).toEqual([t2.id]);
  });

  it('refuses a second running mute on the same target and counts only active timeouts', async () => {
    const { guildId, a, b, bet } = await setup();
    const token = (await insertToken(db, { guildId, betId: bet.id, holderId: a, targetId: b, durationS: 60, expiresAt: null }))!;
    const { bet: bet2 } = await setup();
    const token2 = (await insertToken(db, { guildId, betId: bet2.id, holderId: a, targetId: b, durationS: 60, expiresAt: null }))!;
    const now = new Date();
    const ends = new Date(now.getTime() + HOUR);
    const mute = await insertMute(db, { guildId, tokenId: token.id, targetId: b, kind: 'timeout', startsAt: now, endsAt: ends });
    expect(mute).toBeDefined();
    expect(await insertMute(db, { guildId, tokenId: token2.id, targetId: b, kind: 'timeout', startsAt: now, endsAt: ends })).toBeUndefined();
    expect(await countCapMutes(db, guildId)).toBe(1);

    await transitionMute(db, mute!.id, 'active', 'completed', { completedAt: now });
    expect(await countCapMutes(db, guildId)).toBe(0);
    expect(await lastMuteEnd(db, guildId, b)).toEqual(now);
  });

  it('serializes work on a guild with a row lock', async () => {
    const { guildId } = await setup();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((r) => (releaseFirst = r));
    let firstLocked!: () => void;
    const locked = new Promise<void>((r) => (firstLocked = r));

    const first = db.transaction(async (tx) => {
      await lockGuild(tx, guildId);
      order.push('first-locked');
      firstLocked();
      await firstHolds;
      order.push('first-done');
    });
    await locked;
    const second = db.transaction(async (tx) => {
      await lockGuild(tx, guildId);
      order.push('second-locked');
    });
    await new Promise((r) => setTimeout(r, 100));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-locked', 'first-done', 'second-locked']);
  });
});
