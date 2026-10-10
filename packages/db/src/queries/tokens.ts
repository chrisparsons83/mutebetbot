import { makeShortId, type TokenStatus } from '@mutebetbot/shared';
import { and, asc, eq, ilike, inArray, isNotNull, lte, or, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../client.ts';
import { bets, tokens, type BetRow, type TokenRow } from '../schema.ts';

export type NewToken = Omit<typeof tokens.$inferInsert, 'id' | 'shortId' | 'status'>;

/**
 * Issues a token with a fresh short ID. A bet's token is one per bet (unique index), so a repeat returns
 * undefined. A granted token (no `betId`, `grantedBy` set) has nothing to collide with and always issues.
 */
export async function insertToken(db: DbOrTx, values: NewToken): Promise<TokenRow | undefined> {
  const { betId } = values;
  for (let attempt = 0; attempt < 12; attempt++) {
    const shortId = makeShortId('T', 3 + Math.floor(attempt / 4));
    const [row] = await db.insert(tokens).values({ ...values, shortId }).onConflictDoNothing().returning();
    if (row) return row;
    if (betId && (await db.query.tokens.findFirst({ where: eq(tokens.betId, betId) }))) return undefined;
  }
  throw new Error('Could not allocate a token short ID');
}

export async function getToken(db: DbOrTx, id: string): Promise<TokenRow | undefined> {
  return db.query.tokens.findFirst({ where: eq(tokens.id, id) });
}

export async function getTokenByShortId(db: DbOrTx, guildId: string, shortId: string): Promise<TokenRow | undefined> {
  return db.query.tokens.findFirst({ where: and(eq(tokens.guildId, guildId), eq(tokens.shortId, shortId)) });
}

export async function getTokenForBet(db: DbOrTx, betId: string): Promise<TokenRow | undefined> {
  return db.query.tokens.findFirst({ where: eq(tokens.betId, betId) });
}

/** Guarded status transition; undefined if the token wasn't in an expected status. */
export async function transitionToken(
  db: DbOrTx,
  id: string,
  from: TokenStatus | readonly TokenStatus[],
  to: TokenStatus,
  patch: Partial<Pick<TokenRow, 'queuedAt'>> = {},
): Promise<TokenRow | undefined> {
  const fromList = typeof from === 'string' ? [from] : [...from];
  const [row] = await db
    .update(tokens)
    .set({ ...patch, status: to })
    .where(and(eq(tokens.id, id), inArray(tokens.status, fromList)))
    .returning();
  return row;
}

/**
 * Won mutes with the bet each came from (null for a granted mute), oldest first. With `query`, matches the
 * bet's or token's short ID prefix, the bet's terms, or the holder/target (callers resolve names to `userIds`).
 */
export async function listWonMutes(
  db: DbOrTx,
  guildId: string,
  opts: { holderId?: string | undefined; statuses: readonly TokenStatus[]; query?: string; userIds?: readonly string[]; limit?: number },
): Promise<{ token: TokenRow; bet: BetRow | null }[]> {
  const conds: SQL[] = [eq(tokens.guildId, guildId), inArray(tokens.status, [...opts.statuses])];
  if (opts.holderId) conds.push(eq(tokens.holderId, opts.holderId));
  const q = (opts.query ?? '').trim().replace(/[%_\\]/g, '');
  if (q) {
    const match: SQL[] = [ilike(bets.shortId, `${q}%`), ilike(tokens.shortId, `${q}%`), ilike(bets.terms, `%${q}%`)];
    if (opts.userIds?.length) match.push(inArray(tokens.holderId, [...opts.userIds]), inArray(tokens.targetId, [...opts.userIds]));
    conds.push(or(...match)!);
  }
  return db
    .select({ token: tokens, bet: bets })
    .from(tokens)
    .leftJoin(bets, eq(bets.id, tokens.betId))
    .where(and(...conds))
    .orderBy(asc(tokens.issuedAt))
    .limit(opts.limit ?? 100);
}

/** The guild's queue, oldest first. */
export async function queuedTokens(db: DbOrTx, guildId: string): Promise<TokenRow[]> {
  return db
    .select()
    .from(tokens)
    .where(and(eq(tokens.guildId, guildId), eq(tokens.status, 'queued')))
    .orderBy(asc(tokens.queuedAt), asc(tokens.issuedAt));
}

/** Expires every Available token past its expiry. Queued tokens never expire while waiting. */
export async function expireTokens(db: DbOrTx, now: Date): Promise<TokenRow[]> {
  return db
    .update(tokens)
    .set({ status: 'expired' })
    .where(and(eq(tokens.status, 'available'), isNotNull(tokens.expiresAt), lte(tokens.expiresAt, now)))
    .returning();
}

/** Guild IDs that have anything queued (startup: promote what freed up while offline). */
export async function guildsWithQueue(db: DbOrTx): Promise<string[]> {
  const rows = await db.selectDistinct({ guildId: tokens.guildId }).from(tokens).where(eq(tokens.status, 'queued'));
  return rows.map((r) => r.guildId);
}
