import {
  BET_STATUSES,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  DEFAULT_CONFIG,
  MUTE_KINDS,
  MUTE_STATUSES,
  REJOIN_POLICIES,
  TOKEN_EXPIRY_KEYS,
  TOKEN_STATUSES,
  UNMUTABLE_POLICIES,
  type MuteDurationKey,
} from '@mutebetbot/shared';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Discord snowflakes are text (they overflow JS numbers). All times are UTC timestamptz.
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const betStatus = pgEnum('bet_status', BET_STATUSES);
export const claimKind = pgEnum('claim_kind', CLAIM_KINDS);
export const claimStatus = pgEnum('claim_status', CLAIM_STATUSES);
export const tokenStatus = pgEnum('token_status', TOKEN_STATUSES);
export const muteKind = pgEnum('mute_kind', MUTE_KINDS);
export const muteStatus = pgEnum('mute_status', MUTE_STATUSES);
export const tokenExpiry = pgEnum('token_expiry', TOKEN_EXPIRY_KEYS as [string, ...string[]]);
export const unmutablePolicy = pgEnum('unmutable_policy', UNMUTABLE_POLICIES);
export const rejoinPolicy = pgEnum('rejoin_policy', REJOIN_POLICIES);

export const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  markerRoleId: text('marker_role_id'),
  installedAt: tstz('installed_at').notNull().defaultNow(),
  /** Set when the bot is kicked or uninstalled; data is purged 30 days later. */
  removedAt: tstz('removed_at'),
  // Server configuration (DESIGN.md › Server configuration).
  maxConcurrentMutes: integer('max_concurrent_mutes').notNull().default(DEFAULT_CONFIG.maxConcurrentMutes),
  tokenExpiry: tokenExpiry('token_expiry').notNull().default(DEFAULT_CONFIG.tokenExpiry),
  allowedDurations: text('allowed_durations')
    .array()
    .$type<MuteDurationKey[]>()
    .notNull()
    .default(sql`'{30m,1h,2h,6h,24h}'::text[]`),
  confirmWindowS: integer('confirm_window_s').notNull().default(DEFAULT_CONFIG.confirmWindowS),
  targetCooldownS: integer('target_cooldown_s').notNull().default(DEFAULT_CONFIG.targetCooldownS),
  maxOpenProposalsPerUser: integer('max_open_proposals_per_user')
    .notNull()
    .default(DEFAULT_CONFIG.maxOpenProposalsPerUser),
  unmutableMembers: unmutablePolicy('unmutable_members').notNull().default(DEFAULT_CONFIG.unmutableMembers),
  rejoinPolicy: rejoinPolicy('rejoin_policy').notNull().default(DEFAULT_CONFIG.rejoinPolicy),
  adminRoleId: text('admin_role_id'),
  announceChannelId: text('announce_channel_id'),
  enabled: boolean('enabled').notNull().default(DEFAULT_CONFIG.enabled),
});

export const bets = pgTable(
  'bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shortId: text('short_id').notNull(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    challengerId: text('challenger_id').notNull(),
    opponentId: text('opponent_id').notNull(),
    terms: text('terms').notNull(),
    durationS: integer('duration_s').notNull(),
    status: betStatus('status').notNull().default('proposed'),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    challengerAcceptedAt: tstz('challenger_accepted_at'),
    opponentAcceptedAt: tstz('opponent_accepted_at'),
    acceptBy: tstz('accept_by').notNull(),
    winnerId: text('winner_id'),
    resolvedBy: text('resolved_by'),
    resolvedAt: tstz('resolved_at'),
  },
  (t) => [
    uniqueIndex('bets_guild_short_id_uq').on(t.guildId, t.shortId),
    index('bets_proposed_by_challenger_idx')
      .on(t.guildId, t.challengerId)
      .where(sql`${t.status} = 'proposed'`),
    index('bets_message_idx').on(t.messageId),
    index('bets_guild_status_idx').on(t.guildId, t.status),
  ],
);

export const betClaims = pgTable(
  'bet_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    betId: uuid('bet_id')
      .notNull()
      .references(() => bets.id, { onDelete: 'cascade' }),
    claimantId: text('claimant_id').notNull(),
    kind: claimKind('kind').notNull(),
    status: claimStatus('status').notNull().default('open'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    respondBy: tstz('respond_by').notNull(),
    responderId: text('responder_id'),
    respondedAt: tstz('responded_at'),
    reason: text('reason'),
    dmChannelId: text('dm_channel_id'),
    dmMessageId: text('dm_message_id'),
  },
  (t) => [
    uniqueIndex('bet_claims_one_open_uq')
      .on(t.betId)
      .where(sql`${t.status} = 'open'`),
    index('bet_claims_open_respond_by_idx')
      .on(t.respondBy)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shortId: text('short_id').notNull(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** The bet it was won on; null for a token an admin granted. */
    betId: uuid('bet_id').references(() => bets.id, { onDelete: 'cascade' }),
    /** The admin who granted it; null for a token won on a bet. */
    grantedBy: text('granted_by'),
    holderId: text('holder_id').notNull(),
    targetId: text('target_id').notNull(),
    durationS: integer('duration_s').notNull(),
    status: tokenStatus('status').notNull().default('available'),
    issuedAt: tstz('issued_at').notNull().defaultNow(),
    /** Null means the token never expires. Snapshotted from config at issue. */
    expiresAt: tstz('expires_at'),
    queuedAt: tstz('queued_at'),
  },
  (t) => [
    uniqueIndex('tokens_guild_short_id_uq').on(t.guildId, t.shortId),
    // Postgres allows many NULLs here, so granted tokens don't collide.
    uniqueIndex('tokens_bet_uq').on(t.betId),
    // A token comes from a bet or a grant, never both.
    check('tokens_one_origin_ck', sql`(${t.betId} is null) <> (${t.grantedBy} is null)`),
    index('tokens_holder_idx').on(t.guildId, t.holderId, t.status),
    index('tokens_queue_idx')
      .on(t.guildId, t.queuedAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);

export const mutes = pgTable(
  'mutes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    targetId: text('target_id').notNull(),
    kind: muteKind('kind').notNull(),
    status: muteStatus('status').notNull().default('active'),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    /** Seconds left when paused (target left the server). */
    remainingS: integer('remaining_s'),
    /** Exact timeout value the bot wrote; null if it left a longer moderator timeout alone. */
    timeoutSetTo: tstz('timeout_set_to'),
    lastCalloutAt: tstz('last_callout_at'),
    liftedBy: text('lifted_by'),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    uniqueIndex('mutes_token_uq').on(t.tokenId),
    // One running (or paused) bet-mute per target: stacking is never allowed.
    uniqueIndex('mutes_one_running_per_target_uq')
      .on(t.guildId, t.targetId)
      .where(sql`${t.status} in ('active', 'paused')`),
    index('mutes_target_ended_idx').on(t.guildId, t.targetId, t.endsAt),
  ],
);

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    entity: text('entity').$type<'bet' | 'claim' | 'token' | 'mute' | 'guild'>().notNull(),
    entityId: text('entity_id').notNull(),
    actorId: text('actor_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('events_entity_idx').on(t.entity, t.entityId, t.at)],
);

export type GuildRow = typeof guilds.$inferSelect;
export type BetRow = typeof bets.$inferSelect;
export type ClaimRow = typeof betClaims.$inferSelect;
export type TokenRow = typeof tokens.$inferSelect;
export type MuteRow = typeof mutes.$inferSelect;
export type EventRow = typeof events.$inferSelect;
