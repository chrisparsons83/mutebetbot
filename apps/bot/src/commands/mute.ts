import { activeMutesForGuild, getBet, listTokensForHolder, queuedTokens, searchTokens } from '@mutebetbot/db';
import { formatDuration, type TokenStatus } from '@mutebetbot/shared';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { App } from '../context.ts';
import { blockerText, mutedLine } from '../copy.ts';
import { isTokenExpired } from '../domain/mutes.ts';
import { COLORS, describeMute } from '../discord/render.ts';
import { mention, onlyUsers, ts, UserError } from '../discord/util.ts';
import { redeemToken, unqueueToken } from '../services/mutes.ts';
import { announce } from '../services/notify.ts';
import { clip, guildConfig, nameOf, tokenFromOption, type Autocomplete, type Command, type CommandModule } from './common.ts';

async function tokens(app: App, i: Command) {
  const now = new Date();
  const rows = (await listTokensForHolder(app.db, i.guildId, i.user.id, ['available', 'queued'])).filter((t) => !isTokenExpired(t, now));
  const lines = rows.map((t) => {
    const expiry = t.status === 'queued' ? '⏳ queued' : t.expiresAt ? `expires ${ts(t.expiresAt, 'R')}` : 'never expires';
    return `**${t.shortId}** · ${mention(t.targetId)} · ${formatDuration(t.durationS)} · ${expiry}`;
  });
  const embed = new EmbedBuilder()
    .setTitle('Your mute tokens')
    .setDescription(lines.join('\n') || 'No unspent tokens. Win a bet to earn one.')
    .setColor(COLORS.proposed);
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
}

async function redeem(app: App, i: Command) {
  const token = await tokenFromOption(app, i);
  const queue = i.options.getBoolean('queue') ?? false;
  // Discord calls (and possible 429 retries) can exceed 3 s, so defer first.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await redeemToken(app, i.guild, token.id, i.user.id, queue);
  if (r.action === 'queued') {
    await i.editReply(blockerText(r.blocker, true));
    return;
  }
  await i.editReply(`Done: token **${r.token.shortId}** spent.`);
  const line = `${mutedLine(r.mute.targetId, r.token.durationS, r.mute.endsAt, r.mute.kind === 'honor')} Courtesy of ${mention(i.user.id)}.`;
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
      { name: `Muted now (${timeouts}/${config.maxConcurrentMutes})`, value: active.map(describeMute).join('\n') || 'Nobody.' },
      {
        name: `Queue (${queue.length})`,
        value: queue.map((t, n) => `${n + 1}. ${mention(t.targetId)} · ${formatDuration(t.durationS)} · from ${mention(t.holderId)}`).join('\n').slice(0, 1024) || 'Empty.',
      },
    );
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
}

async function execute(app: App, i: Command) {
  switch (i.options.getSubcommand()) {
    case 'tokens':
      return tokens(app, i);
    case 'redeem':
      return redeem(app, i);
    case 'unqueue': {
      const token = await unqueueToken(app, await tokenFromOption(app, i), i.user.id);
      return void (await i.reply({ content: `Token **${token.shortId}** is out of the queue and available again.`, flags: MessageFlags.Ephemeral }));
    }
    case 'status':
      return status(app, i);
    default:
      throw new UserError('Unknown subcommand.');
  }
}

async function autocomplete(app: App, i: Autocomplete) {
  const sub = i.options.getSubcommand();
  const statuses: TokenStatus[] = sub === 'unqueue' ? ['queued'] : ['available'];
  const rows = await searchTokens(app.db, i.guildId, { prefix: i.options.getFocused().trim().toUpperCase(), holderId: i.user.id, statuses });
  const now = new Date();
  await i.respond(
    rows
      .filter((t) => !isTokenExpired(t, now))
      .map((t) => ({ name: clip(`${t.shortId} · mute ${nameOf(i.guild, t.targetId)} for ${formatDuration(t.durationS)}`, 100), value: t.shortId })),
  );
}

export const muteCommand: CommandModule = { name: 'mute', execute, autocomplete };
