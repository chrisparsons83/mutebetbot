import {
  getBetByShortId,
  getGuild,
  getTokenByShortId,
  getTokenForBet,
  toGuildConfig,
  upsertGuild,
  type BetRow,
  type GuildRow,
  type TokenRow,
} from '@mutebetbot/db';
import { formatDuration, MUTE_DURATIONS, normalizeShortId, type GuildConfig } from '@mutebetbot/shared';
import type { AutocompleteInteraction, ChatInputCommandInteraction, Guild } from 'discord.js';
import type { App } from '../context.ts';
import { clip, nameOf, UserError } from '../discord/util.ts';

export type Command = ChatInputCommandInteraction<'cached'>;
export type Autocomplete = AutocompleteInteraction<'cached'>;

export interface CommandModule {
  name: string;
  execute: (app: App, i: Command) => Promise<void>;
  autocomplete?: (app: App, i: Autocomplete) => Promise<void>;
}

/** The guild row, creating it with defaults if install never ran (e.g. the DB was reset). */
export async function guildRow(app: App, guildId: string): Promise<GuildRow> {
  return (await getGuild(app.db, guildId)) ?? (await upsertGuild(app.db, guildId));
}

export async function guildConfig(app: App, guildId: string): Promise<GuildConfig> {
  return toGuildConfig(await guildRow(app, guildId));
}

/** Bets come from autocomplete, whose value is the bet's short ID. Typing one by hand also works. */
export async function betFromOption(app: App, i: Command, name = 'bet'): Promise<BetRow> {
  const raw = i.options.getString(name, true);
  const bet = await getBetByShortId(app.db, i.guildId, normalizeShortId(raw));
  if (!bet) throw new UserError("I couldn't find that bet. Pick one from the list as you type.");
  return bet;
}

/**
 * The mute in the option. Users pick the bet it was won on, so the value is the bet's short ID; a granted mute
 * has no bet, so autocomplete sends the token's own short ID (`T…`) instead. See `wonMuteValue`.
 */
export async function wonMuteFromOption(app: App, i: Command, name = 'bet'): Promise<TokenRow> {
  const raw = normalizeShortId(i.options.getString(name, true));
  if (raw.startsWith('T')) {
    const token = await getTokenByShortId(app.db, i.guildId, raw);
    if (!token) throw new UserError("I couldn't find that mute. Pick one from the list as you type.");
    return token;
  }
  const bet = await betFromOption(app, i, name);
  const token = await getTokenForBet(app.db, bet.id);
  if (!token) throw new UserError('Nobody won a mute on that bet.');
  return token;
}

/** The autocomplete value that `wonMuteFromOption` reads back. */
export const wonMuteValue = (token: Pick<TokenRow, 'shortId'>, bet: Pick<BetRow, 'shortId'> | null) => bet?.shortId ?? token.shortId;

/** Where a mute came from, in plain text (labels can't render mentions): the bet's terms, or who granted it. */
export const wonMuteOrigin = (guild: Guild, token: Pick<TokenRow, 'grantedBy'>, bet: Pick<BetRow, 'terms'> | null) =>
  bet ? bet.terms.split('\n')[0]! : `Granted by ${nameOf(guild, token.grantedBy ?? '')}`;

/** Autocomplete for a `duration` option: the server's allowed durations matching what's typed. */
export async function respondWithDurations(app: App, i: Autocomplete, typed: string): Promise<void> {
  const config = await guildConfig(app, i.guildId);
  const q = typed.toLowerCase();
  await i.respond(config.allowedDurations.filter((d) => d.includes(q)).map((d) => ({ name: formatDuration(MUTE_DURATIONS[d]), value: d })));
}

/** Most member IDs a name search sends to the database; keeps short queries in big servers cheap. */
const MAX_NAME_MATCHES = 100;

/** Members whose display or user name contains the typed text, so autocomplete can search by name. */
export function memberIdsMatching(guild: Guild, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ids: string[] = [];
  for (const m of guild.members.cache.values()) {
    if (m.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q)) ids.push(m.id);
    if (ids.length >= MAX_NAME_MATCHES) break;
  }
  return ids;
}

/** An autocomplete label: a short head, then the bet's terms in parentheses, within Discord's 100 characters. */
export const withTerms = (head: string, terms: string) => `${head} (${clip(terms.split('\n')[0]!.trim(), Math.max(10, 97 - head.length))})`;

/** How a bet appears in autocomplete: the matchup, then the terms. */
export const betChoiceLabel = (guild: Guild, b: Pick<BetRow, 'challengerId' | 'opponentId' | 'terms'>) =>
  withTerms(`${nameOf(guild, b.challengerId)} vs ${nameOf(guild, b.opponentId)}`, b.terms);
