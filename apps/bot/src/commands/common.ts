import { getBetByShortId, getGuild, getTokenByShortId, toGuildConfig, upsertGuild, type BetRow, type GuildRow, type TokenRow } from '@mutebetbot/db';
import { normalizeShortId, type GuildConfig } from '@mutebetbot/shared';
import type { AutocompleteInteraction, ChatInputCommandInteraction, Guild } from 'discord.js';
import type { App } from '../context.ts';
import { UserError } from '../discord/util.ts';

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

export async function betFromOption(app: App, i: Command, name = 'bet'): Promise<BetRow> {
  const raw = i.options.getString(name, true);
  const bet = await getBetByShortId(app.db, i.guildId, normalizeShortId(raw));
  if (!bet) throw new UserError(`No bet \`${raw}\` in this server.`);
  return bet;
}

export async function tokenFromOption(app: App, i: Command, name = 'token'): Promise<TokenRow> {
  const raw = i.options.getString(name, true);
  const token = await getTokenByShortId(app.db, i.guildId, normalizeShortId(raw));
  if (!token) throw new UserError(`No token \`${raw}\` in this server.`);
  return token;
}

/** Display name for autocomplete labels (which can't render mentions). */
export function nameOf(guild: Guild, userId: string): string {
  return guild.members.cache.get(userId)?.displayName ?? guild.client.users.cache.get(userId)?.username ?? 'someone';
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
