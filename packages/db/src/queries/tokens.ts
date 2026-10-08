import { makeShortId, type TokenStatus } from '@mutebetbot/shared';
import { and, asc, eq, ilike, inArray, isNotNull, lte, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../client.ts';
import { tokens, type TokenRow } from '../schema.ts';

export type NewToken = Omit<typeof tokens.$inferInsert, 'id' | 'shortId' | 'status'>;

/** Issues a token with a fresh short ID. One token per bet (unique index), so a repeat returns undefined. */
export async function insertToken(db: DbOrTx, values: NewToken): Promise<TokenRow | undefined> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const shortId = makeShortId('T', 3 + Math.floor(attempt / 4));
    const [row] = await db.insert(tokens).values({ ...values, shortId }).onConflictDoNothing().returning();
    if (row) return row;
    const existing = await db.query.tokens.findFirst({ where: eq(tokens.betId, values.betId) });
    if (existing) return undefined;
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

export async function listTokensForHolder(
  db: DbOrTx,
  guildId: string,
  holderId: string,
  statuses: readonly TokenStatus[],
): Promise<TokenRow[]> {
  return db
    .select()
    .from(tokens)
    .where(and(eq(tokens.guildId, guildId), eq(tokens.holderId, holderId), inArray(tokens.status, [...statuses])))
    .orderBy(asc(tokens.issuedAt));
}

export async function searchTokens(
  db: DbOrTx,
  guildId: string,
  opts: { prefix: string; holderId?: string | undefined; statuses?: readonly TokenStatus[]; limit?: number },
): Promise<TokenRow[]> {
  const conds: SQL[] = [eq(tokens.guildId, guildId), ilike(tokens.shortId, `${opts.prefix.replace(/[%_\\]/g, '')}%`)];
  if (opts.holderId) conds.push(eq(tokens.holderId, opts.holderId));
  if (opts.statuses?.length) conds.push(inArray(tokens.status, [...opts.statuses]));
  return db
    .select()
    .from(tokens)
    .where(and(...conds))
    .orderBy(asc(tokens.issuedAt))
    .limit(opts.limit ?? 25);
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
