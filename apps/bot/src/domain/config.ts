import {
  CONFIG_LIMITS,
  formatDuration,
  isMuteDurationKey,
  isTokenExpiryKey,
  MUTE_DURATION_KEYS,
  parseDuration,
  REJOIN_POLICIES,
  UNMUTABLE_POLICIES,
  type GuildConfig,
  type MuteDurationKey,
  type RejoinPolicy,
  type UnmutablePolicy,
} from '@mutebetbot/shared';

/** Raw `/mutebet config set` options; null/undefined means "not given". */
export interface ConfigSetInput {
  max_concurrent_mutes?: number | null;
  token_expiry?: string | null;
  allowed_durations?: string | null;
  confirm_window?: string | null;
  target_cooldown?: string | null;
  max_open_proposals_per_user?: number | null;
  unmutable_members?: string | null;
  rejoin_policy?: string | null;
  admin_role?: string | null;
  clear_admin_role?: boolean | null;
  announce_channel?: string | null;
  clear_announce_channel?: boolean | null;
  enabled?: boolean | null;
}

const given = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

function inRange(name: string, v: number, { min, max }: { min: number; max: number }, errors: string[], fmt: (n: number) => string = String) {
  if (v < min || v > max) errors.push(`\`${name}\` must be between ${fmt(min)} and ${fmt(max)}.`);
}

/** Validates and converts options into a config patch. Changes apply to new bets and tokens only. */
export function parseConfigSet(input: ConfigSetInput): { patch: Partial<GuildConfig>; errors: string[] } {
  const patch: Partial<GuildConfig> = {};
  const errors: string[] = [];

  if (given(input.max_concurrent_mutes)) {
    inRange('max_concurrent_mutes', input.max_concurrent_mutes, CONFIG_LIMITS.maxConcurrentMutes, errors);
    patch.maxConcurrentMutes = input.max_concurrent_mutes;
  }
  if (given(input.token_expiry)) {
    if (isTokenExpiryKey(input.token_expiry)) patch.tokenExpiry = input.token_expiry;
    else errors.push('`token_expiry` must be one of 7d, 30d, 90d, 365d, never.');
  }
  if (given(input.allowed_durations)) {
    const parts = input.allowed_durations.split(/[\s,]+/).filter(Boolean);
    const bad = parts.filter((p) => !isMuteDurationKey(p));
    if (bad.length || !parts.length) {
      errors.push(`\`allowed_durations\` must be a comma-separated subset of ${MUTE_DURATION_KEYS.join(', ')}.`);
    } else {
      // Keep canonical order and drop duplicates.
      patch.allowedDurations = MUTE_DURATION_KEYS.filter((k): k is MuteDurationKey => parts.includes(k));
    }
  }
  for (const [name, key, limits] of [
    ['confirm_window', 'confirmWindowS', CONFIG_LIMITS.confirmWindowS],
    ['target_cooldown', 'targetCooldownS', CONFIG_LIMITS.targetCooldownS],
  ] as const) {
    const raw = input[name];
    if (!given(raw)) continue;
    const seconds = raw.trim() === '0' ? 0 : parseDuration(raw);
    if (seconds === undefined) {
      errors.push(`\`${name}\` should look like 72h, 3d, or 1d 12h.`);
      continue;
    }
    inRange(name, seconds, limits, errors, (s) => (s === 0 ? '0' : formatDuration(s)));
    patch[key] = seconds;
  }
  if (given(input.max_open_proposals_per_user)) {
    inRange('max_open_proposals_per_user', input.max_open_proposals_per_user, CONFIG_LIMITS.maxOpenProposalsPerUser, errors);
    patch.maxOpenProposalsPerUser = input.max_open_proposals_per_user;
  }
  if (given(input.unmutable_members)) {
    if ((UNMUTABLE_POLICIES as readonly string[]).includes(input.unmutable_members)) {
      patch.unmutableMembers = input.unmutable_members as UnmutablePolicy;
    } else errors.push('`unmutable_members` must be honor or reject.');
  }
  if (given(input.rejoin_policy)) {
    if ((REJOIN_POLICIES as readonly string[]).includes(input.rejoin_policy)) patch.rejoinPolicy = input.rejoin_policy as RejoinPolicy;
    else errors.push('`rejoin_policy` must be restart_full or resume_remaining.');
  }
  if (given(input.admin_role) && input.clear_admin_role) errors.push('Set `admin_role` or `clear_admin_role`, not both.');
  else if (given(input.admin_role)) patch.adminRoleId = input.admin_role;
  else if (input.clear_admin_role) patch.adminRoleId = null;

  if (given(input.announce_channel) && input.clear_announce_channel) errors.push('Set `announce_channel` or `clear_announce_channel`, not both.');
  else if (given(input.announce_channel)) patch.announceChannelId = input.announce_channel;
  else if (input.clear_announce_channel) patch.announceChannelId = null;

  if (given(input.enabled)) patch.enabled = input.enabled;
  return { patch, errors };
}
