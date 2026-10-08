import { makeShortId, type BetStatus } from '@mutebetbot/shared';
import { and, count, desc, eq, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../client.ts';
import { bets, type BetRow } from '../schema.ts';

export type NewBet = Omit<typeof bets.$inferInsert, 'id' | 'shortId' | 'status'>;

/** Inserts a Proposed bet with a fresh short ID, retrying (and lengthening) on collision. */
export async function insertBet(db: DbOrTx, values: NewBet): Promise<BetRow> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const shortId = makeShortId('B', 3 + Math.floor(attempt / 4));
    const [row] = await db
      .insert(bets)
      .values({ ...values, shortId })
      .onConflictDoNothing({ target: [bets.guildId, bets.shortId] })
      .returning();
    if (row) return row;
  }
  throw new Error('Could not allocate a bet short ID');
}

export async function getBet(db: DbOrTx, id: string): Promise<BetRow | undefined> {
  return db.query.bets.findFirst({ where: eq(bets.id, id) });
}

export async function getBetByShortId(db: DbOrTx, guildId: string, shortId: string): Promise<BetRow | undefined> {
  return db.query.bets.findFirst({ where: and(eq(bets.guildId, guildId), eq(bets.shortId, shortId)) });
}

export async function getBetByMessage(db: DbOrTx, messageId: string): Promise<BetRow | undefined> {
  return db.query.bets.findFirst({ where: eq(bets.messageId, messageId) });
}

export async function countProposedByChallenger(db: DbOrTx, guildId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(bets)
    .where(and(eq(bets.guildId, guildId), eq(bets.challengerId, userId), eq(bets.status, 'proposed')));
  return row?.n ?? 0;
}

/**
 * Guarded status transition: `UPDATE … WHERE id = $id AND status IN ($from)`.
 * Returns the updated row, or undefined if the bet wasn't in an expected status (lost a race).
 */
export async function transitionBet(
  db: DbOrTx,
  id: string,
  from: BetStatus | readonly BetStatus[],
  to: BetStatus,
  patch: Partial<Omit<BetRow, 'id' | 'status'>> = {},
): Promise<BetRow | undefined> {
  const fromList = typeof from === 'string' ? [from] : [...from];
  const [row] = await db
    .update(bets)
    .set({ ...patch, status: to })
    .where(and(eq(bets.id, id), inArray(bets.status, fromList)))
    .returning();
  return row;
}

/** Records one party's Accept while the bet is still Proposed. Idempotent per party. */
export async function recordAcceptance(
  db: DbOrTx,
  id: string,
  side: 'challenger' | 'opponent',
  at: Date,
): Promise<BetRow | undefined> {
  const col = side === 'challenger' ? { challengerAcceptedAt: at } : { opponentAcceptedAt: at };
  const [row] = await db
    .update(bets)
    .set(col)
    .where(and(eq(bets.id, id), eq(bets.status, 'proposed')))
    .returning();
  return row;
}

export async function setBetMessage(db: DbOrTx, id: string, channelId: string, messageId: string): Promise<void> {
  await db.update(bets).set({ channelId, messageId }).where(eq(bets.id, id));
}

export interface BetListFilter {
  userId?: string | undefined;
  statuses?: readonly BetStatus[] | undefined;
}

export async function listBets(
  db: DbOrTx,
  guildId: string,
  filter: BetListFilter,
  page: { limit: number; offset: number },
): Promise<{ rows: BetRow[]; total: number }> {
  const conds: SQL[] = [eq(bets.guildId, guildId)];
  if (filter.userId) conds.push(or(eq(bets.challengerId, filter.userId), eq(bets.opponentId, filter.userId))!);
  if (filter.statuses?.length) conds.push(inArray(bets.status, [...filter.statuses]));
  const where = and(...conds);
  const [rows, [totalRow]] = await Promise.all([
    db.select().from(bets).where(where).orderBy(desc(bets.createdAt)).limit(page.limit).offset(page.offset),
    db.select({ n: count() }).from(bets).where(where),
  ]);
  return { rows, total: totalRow?.n ?? 0 };
}

/** Bets for autocomplete: matching short-ID prefix, optionally limited to a party and statuses. */
export async function searchBets(
  db: DbOrTx,
  guildId: string,
  opts: { prefix: string; partyId?: string | undefined; statuses?: readonly BetStatus[] | undefined; limit?: number },
): Promise<BetRow[]> {
  const conds: SQL[] = [eq(bets.guildId, guildId), ilike(bets.shortId, `${opts.prefix.replace(/[%_\\]/g, '')}%`)];
  if (opts.partyId) conds.push(or(eq(bets.challengerId, opts.partyId), eq(bets.opponentId, opts.partyId))!);
  if (opts.statuses?.length) conds.push(inArray(bets.status, [...opts.statuses]));
  return db
    .select()
    .from(bets)
    .where(and(...conds))
    .orderBy(desc(bets.createdAt))
    .limit(opts.limit ?? 25);
}

/** Proposed bets whose acceptance window has passed. */
export async function overdueProposals(db: DbOrTx, now: Date): Promise<BetRow[]> {
  return db
    .select()
    .from(bets)
    .where(and(eq(bets.status, 'proposed'), lte(bets.acceptBy, now)));
}
