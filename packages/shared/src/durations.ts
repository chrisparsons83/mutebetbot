/** Mute durations a bet can stake, in seconds. Order is display order. */
export const MUTE_DURATIONS = {
  '30m': 30 * 60,
  '1h': 60 * 60,
  '2h': 2 * 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
} as const;

export type MuteDurationKey = keyof typeof MUTE_DURATIONS;
export const MUTE_DURATION_KEYS = Object.keys(MUTE_DURATIONS) as MuteDurationKey[];

export function isMuteDurationKey(v: string): v is MuteDurationKey {
  return Object.hasOwn(MUTE_DURATIONS, v);
}

export function durationKeyForSeconds(seconds: number): MuteDurationKey | undefined {
  return MUTE_DURATION_KEYS.find((k) => MUTE_DURATIONS[k] === seconds);
}

/** Token expiry options. `never` means tokens don't expire. */
export const TOKEN_EXPIRY = {
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
  '90d': 90 * 86_400,
  '365d': 365 * 86_400,
  never: null,
} as const;

export type TokenExpiryKey = keyof typeof TOKEN_EXPIRY;
export const TOKEN_EXPIRY_KEYS = Object.keys(TOKEN_EXPIRY) as TokenExpiryKey[];

export function isTokenExpiryKey(v: string): v is TokenExpiryKey {
  return Object.hasOwn(TOKEN_EXPIRY, v);
}

/** Human-readable duration, e.g. 4500 → "1h 15m". Rounds up to the minute; shows days past 48h. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  let mins = Math.ceil(seconds / 60);
  const days = mins >= 48 * 60 ? Math.floor(mins / 1440) : 0;
  mins -= days * 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

/** Parses "90m", "72h", "7d", "1d 12h" into seconds. Returns undefined on bad input. */
export function parseDuration(input: string): number | undefined {
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  const re = /(\d+)\s*([dhm])/g;
  if (s.replace(re, '').trim() !== '') return undefined;
  let total = 0;
  for (const match of s.matchAll(re)) {
    const unit = match[2];
    total += Number(match[1]) * (unit === 'd' ? 86_400 : unit === 'h' ? 3600 : 60);
  }
  return total > 0 ? total : undefined;
}
