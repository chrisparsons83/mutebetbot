import type { GuildConfig } from '@mutebetbot/shared';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../client.ts';
import { guilds, type GuildRow } from '../schema.ts';

export function toGuildConfig(row: GuildRow): GuildConfig {
  return {
    maxConcurrentMutes: row.maxConcurrentMutes,
    tokenExpiry: row.tokenExpiry as GuildConfig['tokenExpiry'],
    allowedDurations: row.allowedDurations,
    confirmWindowS: row.confirmWindowS,
    targetCooldownS: row.targetCooldownS,
    maxOpenProposalsPerUser: row.maxOpenProposalsPerUser,
    unmutableMembers: row.unmutableMembers,
    rejoinPolicy: row.rejoinPolicy,
    adminRoleId: row.adminRoleId,
    announceChannelId: row.announceChannelId,
    enabled: row.enabled,
  };
}

/** Inserts a guild with default config, or revives a soft-deleted one (keeping its history and settings). */
export async function upsertGuild(db: DbOrTx, id: string): Promise<GuildRow> {
  const [row] = await db
    .insert(guilds)
    .values({ id })
    .onConflictDoUpdate({ target: guilds.id, set: { removedAt: null } })
    .returning();
  return row!;
}

export async function getGuild(db: DbOrTx, id: string): Promise<GuildRow | undefined> {
  return db.query.guilds.findFirst({ where: eq(guilds.id, id) });
}

/** Row-locks the guild for the rest of the transaction. Serializes redemptions and queue promotion. */
export async function lockGuild(tx: Tx, id: string): Promise<GuildRow | undefined> {
  const [row] = await tx.select().from(guilds).where(eq(guilds.id, id)).for('update');
  return row;
}

export async function updateGuildConfig(db: DbOrTx, id: string, patch: Partial<GuildConfig>): Promise<GuildRow | undefined> {
  if (Object.keys(patch).length === 0) return getGuild(db, id);
  const [row] = await db.update(guilds).set(patch).where(eq(guilds.id, id)).returning();
  return row;
}

export async function setMarkerRole(db: DbOrTx, id: string, roleId: string | null): Promise<void> {
  await db.update(guilds).set({ markerRoleId: roleId }).where(eq(guilds.id, id));
}

export async function markGuildRemoved(db: DbOrTx, id: string, at = new Date()): Promise<void> {
  await db.update(guilds).set({ removedAt: at }).where(eq(guilds.id, id));
}

/** Hard-deletes guilds removed before `before`; cascades to all their data. Returns purged IDs. */
export async function purgeRemovedGuilds(db: DbOrTx, before: Date): Promise<string[]> {
  const rows = await db
    .delete(guilds)
    .where(and(isNotNull(guilds.removedAt), lt(guilds.removedAt, before)))
    .returning({ id: guilds.id });
  return rows.map((r) => r.id);
}

export async function listInstalledGuildIds(db: DbOrTx): Promise<string[]> {
  const rows = await db.select({ id: guilds.id }).from(guilds).where(sql`${guilds.removedAt} is null`);
  return rows.map((r) => r.id);
}
