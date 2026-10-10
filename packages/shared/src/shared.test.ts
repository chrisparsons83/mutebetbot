import { describe, expect, it } from 'vitest';
import { BOT_PERMISSIONS, formatDuration, inviteUrl, makeShortId, normalizeShortId, parseDuration } from './index.ts';

describe('durations', () => {
  it('formats rounding up to the minute', () => {
    expect(formatDuration(4320)).toBe('1h 12m');
    expect(formatDuration(59)).toBe('1m');
    expect(formatDuration(86_400)).toBe('24h');
    expect(formatDuration(72 * 3600)).toBe('3d');
    expect(formatDuration(0)).toBe('0m');
  });

  it('parses compound durations and rejects junk', () => {
    expect(parseDuration('72h')).toBe(259_200);
    expect(parseDuration('1d 12h')).toBe(129_600);
    expect(parseDuration('90m')).toBe(5400);
    expect(parseDuration('abc')).toBeUndefined();
    expect(parseDuration('5x')).toBeUndefined();
    expect(parseDuration('0h')).toBeUndefined();
  });
});

describe('short IDs', () => {
  it('uses the prefix and unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(makeShortId('B')).toMatch(/^B[2-9A-HJKMNP-TV-Z]{3}$/);
    expect(normalizeShortId(' #b7k2 ')).toBe('B7K2');
  });
});

describe('invite', () => {
  it('requests exactly the documented permissions', () => {
    // ViewAuditLog | ViewChannel | SendMessages | EmbedLinks | ReadMessageHistory | ManageRoles | ModerateMembers
    expect(BOT_PERMISSIONS).toBe(1099780148352n);
    const url = new URL(inviteUrl('123'));
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    expect(url.searchParams.get('permissions')).toBe('1099780148352');
  });
});
