import { randomInt } from 'node:crypto';

/** No 0/O, 1/I/L, or U, so IDs survive being read aloud or retyped. */
export const SHORT_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export type ShortIdPrefix = 'B' | 'T';

/** `B7K2`-style ID. Callers retry on a unique-index collision with a longer length. */
export function makeShortId(prefix: ShortIdPrefix, length = 3): string {
  let out = prefix;
  for (let i = 0; i < length; i++) out += SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)];
  return out;
}

/** Normalizes user input: trims, drops a leading `#`, uppercases. */
export function normalizeShortId(input: string): string {
  return input.trim().replace(/^#/, '').toUpperCase();
}
