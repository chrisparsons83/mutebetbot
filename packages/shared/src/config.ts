import { MUTE_DURATION_KEYS, type MuteDurationKey, type TokenExpiryKey } from './durations.ts';

export const UNMUTABLE_POLICIES = ['honor', 'reject'] as const;
export type UnmutablePolicy = (typeof UNMUTABLE_POLICIES)[number];

export const REJOIN_POLICIES = ['restart_full', 'resume_remaining'] as const;
export type RejoinPolicy = (typeof REJOIN_POLICIES)[number];

/** Per-server settings. Every field has a safe default so the bot works on join. */
export interface GuildConfig {
  maxConcurrentMutes: number;
  tokenExpiry: TokenExpiryKey;
  allowedDurations: MuteDurationKey[];
  confirmWindowS: number;
  targetCooldownS: number;
  maxOpenProposalsPerUser: number;
  unmutableMembers: UnmutablePolicy;
  rejoinPolicy: RejoinPolicy;
  adminRoleId: string | null;
  announceChannelId: string | null;
  enabled: boolean;
}

export const DEFAULT_CONFIG: GuildConfig = {
  maxConcurrentMutes: 3,
  tokenExpiry: '30d',
  allowedDurations: [...MUTE_DURATION_KEYS],
  confirmWindowS: 72 * 3600,
  targetCooldownS: 24 * 3600,
  maxOpenProposalsPerUser: 3,
  unmutableMembers: 'honor',
  rejoinPolicy: 'restart_full',
  adminRoleId: null,
  announceChannelId: null,
  enabled: true,
};

export const CONFIG_LIMITS = {
  maxConcurrentMutes: { min: 1, max: 25 },
  confirmWindowS: { min: 3600, max: 14 * 86_400 },
  targetCooldownS: { min: 0, max: 7 * 86_400 },
  maxOpenProposalsPerUser: { min: 1, max: 10 },
} as const;

/** Fixed, system-wide: proposals expire 48 h after creation. */
export const PROPOSAL_TTL_S = 48 * 3600;
/** Per-user cooldown between `/bet create` calls. */
export const CREATE_COOLDOWN_S = 30;
/** Minimum gap between honor-mute callouts for one user. */
export const HONOR_CALLOUT_INTERVAL_S = 10 * 60;
/** How often the sweep enforces expiries and windows. */
export const SWEEP_INTERVAL_S = 5 * 60;
/** Soft-deleted guild data is purged this long after removal. */
export const GUILD_PURGE_AFTER_S = 30 * 86_400;
export const TERMS_MAX_LENGTH = 200;

export const MARKER_ROLE_NAME = 'MuteBetBot · Muted';
