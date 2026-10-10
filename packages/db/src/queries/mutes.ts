import type { MuteStatus } from '@mutebetbot/shared';
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../client.ts';
import { mutes, type MuteRow } from '../schema.ts';

export type NewMute = Omit<typeof mutes.$inferInsert, 'id' | 'status'>;

/** Returns undefined if the target already has a running or paused bet-mute (unique index). */
export async function insertMute(db: DbOrTx, values: NewMute): Promise<MuteRow | undefined> {
  const [row] = await db.insert(mutes).values(values).onConflictDoNothing().returning();
  return row;
}

export async function getMute(db: DbOrTx, id: string): Promise<MuteRow | undefined> {
  return db.query.mutes.findFirst({ where: eq(mutes.id, id) });
}

/** The mute a won bet turned into, if it has been used. */
export async function getMuteForToken(db: DbOrTx, tokenId: string): Promise<MuteRow | undefined> {
  return db.query.mutes.findFirst({ where: eq(mutes.tokenId, tokenId) });
}

export async function transitionMute(
  db: DbOrTx,
  id: string,
  from: MuteStatus | readonly MuteStatus[],
  to: MuteStatus,
  patch: Partial<Omit<MuteRow, 'id' | 'status' | 'guildId' | 'tokenId' | 'targetId'>> = {},
): Promise<MuteRow | undefined> {
  const fromList = typeof from === 'string' ? [from] : [...from];
  const [row] = await db
    .update(mutes)
    .set({ ...patch, status: to })
    .where(and(eq(mutes.id, id), inArray(mutes.status, fromList)))
    .returning();
  return row;
}

export async function updateMute(
  db: DbOrTx,
  id: string,
  patch: Partial<Pick<MuteRow, 'lastCalloutAt' | 'timeoutSetTo'>>,
): Promise<void> {
  await db.update(mutes).set(patch).where(eq(mutes.id, id));
}

/** Timeout mutes currently counting toward the cap. Paused and honor mutes don't count. */
export async function countCapMutes(db: DbOrTx, guildId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(mutes)
    .where(and(eq(mutes.guildId, guildId), eq(mutes.status, 'active'), eq(mutes.kind, 'timeout')));
  return row?.n ?? 0;
}

export async function activeMutesForGuild(db: DbOrTx, guildId: string): Promise<MuteRow[]> {
  return db
    .select()
    .from(mutes)
    .where(and(eq(mutes.guildId, guildId), eq(mutes.status, 'active')))
    .orderBy(asc(mutes.endsAt));
}

/** Every active mute across all guilds (startup reconciliation). */
export async function allActiveMutes(db: DbOrTx): Promise<MuteRow[]> {
  return db.select().from(mutes).where(eq(mutes.status, 'active'));
}

/** The target's running or paused bet-mute, if any. */
export async function runningMuteForTarget(db: DbOrTx, guildId: string, targetId: string): Promise<MuteRow | undefined> {
  return db.query.mutes.findFirst({
    where: and(eq(mutes.guildId, guildId), eq(mutes.targetId, targetId), inArray(mutes.status, ['active', 'paused'])),
  });
}

export async function activeMuteForTarget(db: DbOrTx, guildId: string, targetId: string): Promise<MuteRow | undefined> {
  return db.query.mutes.findFirst({
    where: and(eq(mutes.guildId, guildId), eq(mutes.targetId, targetId), eq(mutes.status, 'active')),
  });
}

/** When the target's most recent completed bet-mute actually ended (for the cooldown). */
export async function lastMuteEnd(db: DbOrTx, guildId: string, targetId: string): Promise<Date | undefined> {
  const [row] = await db
    .select({ completedAt: mutes.completedAt, endsAt: mutes.endsAt })
    .from(mutes)
    .where(and(eq(mutes.guildId, guildId), eq(mutes.targetId, targetId), ne(mutes.status, 'active'), ne(mutes.status, 'paused')))
    .orderBy(sql`coalesce(${mutes.completedAt}, ${mutes.endsAt}) desc`)
    .limit(1);
  if (!row) return undefined;
  return row.completedAt ?? row.endsAt;
}

/** Active and paused mutes in a guild (uninstall lifts all of them). */
export async function runningMutesForGuild(db: DbOrTx, guildId: string): Promise<MuteRow[]> {
  return db
    .select()
    .from(mutes)
    .where(and(eq(mutes.guildId, guildId), inArray(mutes.status, ['active', 'paused'])));
}
