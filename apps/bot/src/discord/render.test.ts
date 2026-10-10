import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BetRow, MuteRow, TokenRow } from '@mutebetbot/db';
import { describe, expect, it } from 'vitest';
import { renderBetMessage } from './render.ts';
import { betClaim } from './util.ts';

const now = new Date('2026-10-09T22:46:00Z');
const H = 3600_000;

const bet = (over: Partial<BetRow> = {}): BetRow => ({
  id: 'bet-uuid',
  shortId: 'BAT3',
  guildId: 'g',
  challengerId: '1',
  opponentId: '2',
  terms: 'Test bet',
  durationS: 1800,
  status: 'proposed',
  channelId: 'c',
  messageId: null,
  createdAt: now,
  challengerAcceptedAt: null,
  opponentAcceptedAt: null,
  acceptBy: new Date(now.getTime() + 48 * H),
  winnerId: null,
  resolvedBy: null,
  resolvedAt: null,
  ...over,
});

const token = (over: Partial<TokenRow> = {}): TokenRow => ({
  id: 'token-uuid',
  shortId: 'THKG',
  guildId: 'g',
  betId: 'bet-uuid',
  grantedBy: null,
  holderId: '1',
  targetId: '2',
  durationS: 1800,
  status: 'available',
  issuedAt: now,
  expiresAt: new Date(now.getTime() + 30 * 24 * H),
  queuedAt: null,
  ...over,
});

const resolved = bet({ status: 'resolved', winnerId: '1' });
const json = (r: ReturnType<typeof renderBetMessage>) => JSON.stringify({ embeds: r.embeds.map((e) => e.toJSON()), components: r.components.map((c) => c.toJSON()) });
const fieldNames = (r: ReturnType<typeof renderBetMessage>) => (r.embeds[0]!.toJSON().fields ?? []).map((f) => f.name);

describe('betClaim', () => {
  it('reads the prediction as the end of "X bets that ..."', () => {
    expect(betClaim('Oklahoma scores over 30.5 against Texas')).toBe('Oklahoma scores over 30.5 against Texas');
    expect(betClaim('I bet that Oklahoma wins.')).toBe('Oklahoma wins');
    expect(betClaim('that it rains\ntomorrow!')).toBe('it rains tomorrow');
  });
});

describe('renderBetMessage', () => {
  it('opens with the prediction as a sentence', () => {
    const r = renderBetMessage(bet({ terms: 'Oklahoma scores over 30.5 against Texas' }), {}, now);
    expect(r.embeds[0]!.toJSON().description).toBe('<@1> bets that Oklahoma scores over 30.5 against Texas.');
  });

  it('never shows the short IDs', () => {
    for (const r of [renderBetMessage(bet(), {}, now), renderBetMessage(resolved, { token: token(), loserName: 'NLT' }, now)]) {
      expect(json(r)).not.toMatch(/BAT3|THKG/);
    }
  });

  it('proposed: shows who has accepted and the deadline, with the proposal buttons', () => {
    const r = renderBetMessage(bet({ challengerAcceptedAt: now }), {}, now);
    const fields = r.embeds[0]!.toJSON().fields!;
    expect(fields.map((f) => f.name)).toEqual(['Challenger', 'Opponent', 'Stakes', 'Accept by']);
    expect(fields[0]!.value).toContain('Accepted');
    expect(fields[1]!.value).toContain('Not yet');
    expect(r.components).toHaveLength(1);
  });

  it('resolved with an unused mute: winner, loser, deadline, and a Mute button', () => {
    const r = renderBetMessage(resolved, { token: token(), loserName: 'NLT' }, now);
    expect(r.embeds[0]!.toJSON().title).toBe('Settled');
    expect(fieldNames(r)).toEqual(['Winner', 'Loser', 'Stakes', 'Use by']);
    const button = r.components[0]!.toJSON().components[0] as { label: string; custom_id: string };
    expect(button.label).toBe('Mute NLT');
    expect(button.custom_id).toBe('mute:use:token-uuid');
  });

  it('resolved with no expiry: no deadline field', () => {
    const r = renderBetMessage(resolved, { token: token({ expiresAt: null }) }, now);
    expect(fieldNames(r)).toEqual(['Winner', 'Loser', 'Stakes']);
    expect(r.components).toHaveLength(1);
  });

  it('resolved and running: shows when the mute ends, no button', () => {
    const mute = { status: 'active', endsAt: new Date(now.getTime() + H) } as MuteRow;
    const r = renderBetMessage(resolved, { token: token({ status: 'active' }), mute }, now);
    const last = r.embeds[0]!.toJSON().fields!.at(-1)!;
    expect(last.name).toBe('Mute');
    expect(last.value).toMatch(/^Muted until <t:\d+:t>/);
    expect(r.components).toHaveLength(0);
  });

  it('resolved but past the deadline: says it expired, no button', () => {
    const r = renderBetMessage(resolved, { token: token({ expiresAt: new Date(now.getTime() - H) }) }, now);
    expect(r.embeds[0]!.toJSON().fields!.at(-1)!.value).toBe('Expired without being used');
    expect(r.components).toHaveLength(0);
  });
});

/** Characters that make the bot's copy read as machine-written. Comments are exempt. */
const BANNED = /[·—–→“”’]|\p{Extended_Pictographic}/u;
const ROOTS = ['apps/bot/src', 'packages/shared/src', 'apps/web/src'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|astro)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('user-facing copy', () => {
  it('has no middots, dashes, arrows, curly quotes, or emoji', () => {
    const hits = ROOTS.flatMap(sourceFiles).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, n) => ({ line, n }))
        .filter(({ line }) => !/^\s*(\/\/|\/?\*)/.test(line) && BANNED.test(line))
        .map(({ line, n }) => `${file}:${n + 1}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
