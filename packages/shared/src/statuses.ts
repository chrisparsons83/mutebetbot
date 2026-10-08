export const BET_STATUSES = [
  'proposed',
  'active',
  'claim_pending',
  'disputed',
  'resolved',
  'void',
  'declined',
  'expired',
  'cancelled',
] as const;
export type BetStatus = (typeof BET_STATUSES)[number];

export const CLAIM_KINDS = ['win', 'lose', 'void'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** `superseded`: an admin ruled while it was open. `lapsed`: a void proposal nobody answered. */
export const CLAIM_STATUSES = ['open', 'confirmed', 'disputed', 'superseded', 'lapsed'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const TOKEN_STATUSES = ['available', 'queued', 'active', 'completed', 'expired', 'revoked'] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

export const MUTE_KINDS = ['timeout', 'honor'] as const;
export type MuteKind = (typeof MUTE_KINDS)[number];

export const MUTE_STATUSES = ['active', 'paused', 'completed'] as const;
export type MuteStatus = (typeof MUTE_STATUSES)[number];

/** Bet statuses a party can still act on. */
export const OPEN_BET_STATUSES: readonly BetStatus[] = ['proposed', 'active', 'claim_pending', 'disputed'];
