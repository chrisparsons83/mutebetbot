import { activeMutesForGuild, getBet, listWonMutes, queuedTokens } from '@mutebetbot/db';
import { formatDuration, type TokenStatus } from '@mutebetbot/shared';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ButtonInteraction } from 'discord.js';
import type { App } from '../context.ts';
import { blockerText, mutedLine } from '../copy.ts';
import { isTokenExpired } from '../domain/mutes.ts';
import { COLORS, customId, describeMute } from '../discord/render.ts';
import { clip, mention, nameOf, onlyUsers, ts, UserError } from '../discord/util.ts';
import { MuteBlockedError, redeemToken, unqueueToken } from '../services/mutes.ts';
import { announce } from '../services/notify.ts';
import { guildConfig, memberIdsMatching, withTerms, wonMuteFromOption, type Autocomplete, type Command, type CommandModule } from './common.ts';

async function list(app: App, i: Command) {
  const now = new Date();
  const rows = (await listWonMutes(app.db, i.guildId, { holderId: i.user.id, statuses: ['available', 'queued'] })).filter(
    ({ token }) => !isTokenExpired(token, now),
  );
  const fields = rows.slice(0, 25).map(({ token, bet }) => {
    const when = token.status === 'queued' ? 'Waiting in line' : token.expiresAt ? `Use by ${ts(token.expiresAt, 'D')}` : 'No deadline';
    return { name: clip(bet.terms.split('\n')[0]!, 100), value: `${mention(token.targetId)} for ${formatDuration(token.durationS)}\n${when}` };
  });
  const embed = new EmbedBuilder()
    .setTitle("Mutes you've won")
    .setColor(COLORS.proposed)
    .addFields(fields);
  if (!fields.length) embed.setDescription("You don't have any mutes to use. Win a bet to get one.");
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
}

/** How the mute was asked for: the command, the Mute button on the bet card, or Wait in line after a block. */
type UseVia = 'command' | 'button' | 'queue_button';

/** Starts (or queues) a won mute and posts the public line. Shared by `/mute use` and the buttons. */
export async function useMute(app: App, i: Command | ButtonInteraction<'cached'>, tokenId: string, queue: boolean, via: UseVia) {
  // Discord calls (and possible 429 retries) can exceed 3 s, so defer first.
  if (via === 'queue_button' && i.isButton()) await i.deferUpdate();
  else await i.deferReply({ flags: MessageFlags.Ephemeral });

  let r;
  try {
    r = await redeemToken(app, i.guild, tokenId, i.user.id, queue);
  } catch (e) {
    if (via === 'button' && e instanceof MuteBlockedError) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(customId.queueMute(tokenId)).setLabel('Wait in line').setStyle(ButtonStyle.Primary),
      );
      await i.editReply({ content: blockerText(e.blocker, 'button'), components: [row] });
      return;
    }
    throw e;
  }
  if (r.action === 'queued') {
    await i.editReply({ content: blockerText(r.blocker, 'queued'), components: [] });
    return;
  }
  await i.editReply({ content: 'The mute has started.', components: [] });
  const line = mutedLine(r.mute.targetId, i.user.id, r.mute.endsAt, r.mute.kind === 'honor');
  const pings = onlyUsers(r.mute.targetId, i.user.id);
  // Post where it happened; also in the announce channel if one is configured elsewhere.
  await i.followUp({ content: line, allowedMentions: pings });
  const config = await guildConfig(app, i.guildId);
  if (config.announceChannelId && config.announceChannelId !== i.channelId) {
    const bet = await getBet(app.db, r.token.betId);
    await announce(app, i.guild, bet?.channelId ?? null, { content: line, allowedMentions: pings });
  }
}

async function status(app: App, i: Command) {
  const [active, queue, config] = await Promise.all([activeMutesForGuild(app.db, i.guildId), queuedTokens(app.db, i.guildId), guildConfig(app, i.guildId)]);
  const timeouts = active.filter((m) => m.kind === 'timeout').length;
  const embed = new EmbedBuilder()
    .setTitle('Bet-mutes')
    .setColor(COLORS.muted)
    .addFields(
      { name: `Muted now (${timeouts} of ${config.maxConcurrentMutes})`, value: active.map(describeMute).join('\n') || 'Nobody' },
      {
        name: `Waiting in line (${queue.length})`,
        value: queue.map((t, n) => `${n + 1}. ${mention(t.targetId)} for ${formatDuration(t.durationS)}, won by ${mention(t.holderId)}`).join('\n').slice(0, 1024) || 'Nobody',
      },
    );
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
}

async function execute(app: App, i: Command) {
  switch (i.options.getSubcommand()) {
    case 'list':
      return list(app, i);
    case 'use': {
      const token = await wonMuteFromOption(app, i);
      return useMute(app, i, token.id, i.options.getBoolean('queue') ?? false, 'command');
    }
    case 'unqueue': {
      await unqueueToken(app, await wonMuteFromOption(app, i), i.user.id);
      return void (await i.reply({ content: "It's out of line and back in `/mute list`.", flags: MessageFlags.Ephemeral }));
    }
    case 'status':
      return status(app, i);
    default:
      throw new UserError('Unknown subcommand.');
  }
}

async function autocomplete(app: App, i: Autocomplete) {
  const statuses: TokenStatus[] = i.options.getSubcommand() === 'unqueue' ? ['queued'] : ['available'];
  const query = i.options.getFocused();
  const rows = await listWonMutes(app.db, i.guildId, { holderId: i.user.id, statuses, query, userIds: memberIdsMatching(i.guild, query) });
  const now = new Date();
  await i.respond(
    rows
      .filter(({ token }) => !isTokenExpired(token, now))
      .map(({ token, bet }) => {
        const name = withTerms(`Mute ${nameOf(i.guild, token.targetId)} for ${formatDuration(token.durationS)}`, bet.terms);
        return { name, value: bet.shortId };
      })
      .slice(0, 25),
  );
}

export const muteCommand: CommandModule = { name: 'mute', execute, autocomplete };
