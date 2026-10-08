import { getGuild, toGuildConfig } from '@mutebetbot/db';
import type { Guild, MessageCreateOptions } from 'discord.js';
import type { App } from '../context.ts';
import { sendableChannel } from '../discord/util.ts';

/**
 * Posts to the configured announce channel, else the fallback (usually the bet's channel).
 * Best-effort: a missing channel or permission is logged, not thrown.
 */
export async function announce(app: App, guild: Guild, fallbackChannelId: string | null, payload: MessageCreateOptions) {
  const row = await getGuild(app.db, guild.id);
  const configured = row ? toGuildConfig(row).announceChannelId : null;
  const channel = (await sendableChannel(guild, configured)) ?? (await sendableChannel(guild, fallbackChannelId));
  if (!channel) {
    app.log.warn({ guildId: guild.id }, 'no channel to announce in');
    return null;
  }
  return channel.send({ allowedMentions: { parse: [] }, ...payload }).catch((e: unknown) => {
    app.log.warn({ err: e, guildId: guild.id }, 'announce failed');
    return null;
  });
}

export function guildOf(app: App, guildId: string): Guild | undefined {
  return app.client.guilds.cache.get(guildId);
}
