import type { ClaimStatus } from '@mutebetbot/shared';
import { and, eq, lte } from 'drizzle-orm';
import type { DbOrTx } from '../client.ts';
import { betClaims, bets, type BetRow, type ClaimRow } from '../schema.ts';

export type NewClaim = Omit<typeof betClaims.$inferInsert, 'id' | 'status'>;

/**
 * Opens a claim. Returns undefined if the bet already has an open claim
 * (the partial unique index on open claims rejects the second one).
 */
export async function insertClaim(db: DbOrTx, values: NewClaim): Promise<ClaimRow | undefined> {
  const [row] = await db.insert(betClaims).values(values).onConflictDoNothing().returning();
  return row;
}

export async function getOpenClaim(db: DbOrTx, betId: string): Promise<ClaimRow | undefined> {
  return db.query.betClaims.findFirst({ where: and(eq(betClaims.betId, betId), eq(betClaims.status, 'open')) });
}

export async function getClaim(db: DbOrTx, id: string): Promise<ClaimRow | undefined> {
  return db.query.betClaims.findFirst({ where: eq(betClaims.id, id) });
}

/** Guarded: only moves a claim that is still open. */
export async function closeClaim(
  db: DbOrTx,
  id: string,
  to: Exclude<ClaimStatus, 'open'>,
  patch: Partial<Pick<ClaimRow, 'responderId' | 'respondedAt' | 'reason'>> = {},
): Promise<ClaimRow | undefined> {
  const [row] = await db
    .update(betClaims)
    .set({ ...patch, status: to })
    .where(and(eq(betClaims.id, id), eq(betClaims.status, 'open')))
    .returning();
  return row;
}

export async function setClaimDm(db: DbOrTx, id: string, dmChannelId: string, dmMessageId: string): Promise<void> {
  await db.update(betClaims).set({ dmChannelId, dmMessageId }).where(eq(betClaims.id, id));
}

export async function setClaimRespondBy(db: DbOrTx, id: string, respondBy: Date): Promise<void> {
  await db
    .update(betClaims)
    .set({ respondBy })
    .where(and(eq(betClaims.id, id), eq(betClaims.status, 'open')));
}

/** Open claims past their window, with their bets. */
export async function overdueClaims(db: DbOrTx, now: Date): Promise<{ claim: ClaimRow; bet: BetRow }[]> {
  return db
    .select({ claim: betClaims, bet: bets })
    .from(betClaims)
    .innerJoin(bets, eq(bets.id, betClaims.betId))
    .where(and(eq(betClaims.status, 'open'), lte(betClaims.respondBy, now)));
}

/** Open claims on bets in a guild where `userId` is a party. */
export async function openClaimsForParty(
  db: DbOrTx,
  guildId: string,
  userId: string,
): Promise<{ claim: ClaimRow; bet: BetRow }[]> {
  const rows = await db
    .select({ claim: betClaims, bet: bets })
    .from(betClaims)
    .innerJoin(bets, eq(bets.id, betClaims.betId))
    .where(and(eq(bets.guildId, guildId), eq(betClaims.status, 'open')));
  return rows.filter((r) => r.bet.challengerId === userId || r.bet.opponentId === userId);
}
