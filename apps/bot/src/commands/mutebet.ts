import { listWonMutes, logEvent, markGuildRemoved, runningMutesForGuild, searchBets, setMarkerRole, toGuildConfig, updateGuildConfig } from '@mutebetbot/db';
import { formatDuration, type GuildConfig } from '@mutebetbot/shared';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { App } from '../context.ts';
import { explain } from '../copy.ts';
import { planAdminRule } from '../domain/bets.ts';
import { parseConfigSet } from '../domain/config.ts';
import { isBotAdmin } from '../domain/members.ts';
import { COLORS } from '../discord/render.ts';
import { isMutable, memberAuthority, mention, nameOf, onlyUsers, theBet, UserError } from '../discord/util.ts';
import { isTokenExpired } from '../domain/mutes.ts';
import { adminRule } from '../services/bets.ts';
import { buildSetupReport, ensureMarkerRole, setupEmbed } from '../services/guild-setup.ts';
import { adminUnmute, finalizeMute, grantToken, revokeToken } from '../services/mutes.ts';
import {
  betChoiceLabel,
  betFromOption,
  guildConfig,
  guildRow,
  memberIdsMatching,
  respondWithDurations,
  withTerms,
  wonMuteFromOption,
  wonMuteOrigin,
  wonMuteValue,
  type Autocomplete,
  type Command,
  type CommandModule,
} from './common.ts';

function describeConfig(c: GuildConfig): string {
  return [
    `**max_concurrent_mutes:** ${c.maxConcurrentMutes}`,
    `**mute_expiry:** ${c.tokenExpiry}`,
    `**allowed_durations:** ${c.allowedDurations.join(', ')}`,
    `**confirm_window:** ${formatDuration(c.confirmWindowS)}`,
    `**target_cooldown:** ${c.targetCooldownS ? formatDuration(c.targetCooldownS) : 'none'}`,
    `**max_open_proposals_per_user:** ${c.maxOpenProposalsPerUser}`,
    `**unmutable_members:** ${c.unmutableMembers}`,
    `**rejoin_policy:** ${c.rejoinPolicy}`,
    `**admin_role:** ${c.adminRoleId ? `<@&${c.adminRoleId}>` : 'none (Manage Server only)'}`,
    `**announce_channel:** ${c.announceChannelId ? `<#${c.announceChannelId}>` : 'none (same channel)'}`,
    `**enabled:** ${c.enabled ? 'yes' : 'no'}`,
  ].join('\n');
}

async function rule(app: App, i: Command) {
  const bet = await betFromOption(app, i);
  const winner = i.options.getUser('winner');
  const asVoid = i.options.getBoolean('void') ?? false;
  if (Boolean(winner) === asVoid) throw new UserError('Pick a `winner`, or set `void:true`, but not both.');
  const plan = planAdminRule(bet, i.user.id, asVoid ? { void: true } : { winnerId: winner!.id });
  if (!plan.ok) throw new UserError(explain(plan));
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await adminRule(app, bet, i.user.id, plan.outcome);
  await i.editReply({
    content: r.bet.status === 'void' ? `Called off ${theBet(bet.terms)}.` : `Settled ${theBet(bet.terms)}. ${mention(r.bet.winnerId!)} won.`,
    allowedMentions: onlyUsers(),
  });
}

async function grant(app: App, i: Command, config: GuildConfig) {
  const facts = (name: 'holder' | 'target') => {
    const user = i.options.getUser(name, true);
    const member = i.options.getMember(name);
    return { id: user.id, isBot: user.bot, inGuild: Boolean(member), mutable: member ? isMutable(member) : false };
  };
  // Saving the token and DMing the holder can outlast Discord's 3 s reply window.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const { token, dmSent } = await grantToken(app, {
    guildId: i.guildId,
    guildName: i.guild.name,
    config,
    adminId: i.user.id,
    holder: facts('holder'),
    target: facts('target'),
    duration: i.options.getString('duration', true),
    reason: i.options.getString('reason') ?? undefined,
  });
  const sent = dmSent ? "I've sent them a DM." : "I couldn't DM them, so let them know it's in `/mute list`.";
  await i.editReply({
    content: `Gave ${mention(token.holderId)} a ${formatDuration(token.durationS)} mute on ${mention(token.targetId)}. ${sent}`,
    allowedMentions: onlyUsers(),
  });
}

async function configSet(app: App, i: Command) {
  const o = i.options;
  const { patch, errors } = parseConfigSet({
    max_concurrent_mutes: o.getInteger('max_concurrent_mutes'),
    mute_expiry: o.getString('mute_expiry'),
    allowed_durations: o.getString('allowed_durations'),
    confirm_window: o.getString('confirm_window'),
    target_cooldown: o.getString('target_cooldown'),
    max_open_proposals_per_user: o.getInteger('max_open_proposals_per_user'),
    unmutable_members: o.getString('unmutable_members'),
    rejoin_policy: o.getString('rejoin_policy'),
    admin_role: o.getRole('admin_role')?.id ?? null,
    clear_admin_role: o.getBoolean('clear_admin_role'),
    announce_channel: o.getChannel('announce_channel')?.id ?? null,
    clear_announce_channel: o.getBoolean('clear_announce_channel'),
    enabled: o.getBoolean('enabled'),
  });
  if (errors.length) throw new UserError(errors.join('\n'));
  if (!Object.keys(patch).length) throw new UserError('Give at least one setting to change. See `/mutebet config view`.');
  const row = await updateGuildConfig(app.db, i.guildId, patch);
  await logEvent(app.db, { guildId: i.guildId, entity: 'guild', entityId: i.guildId, actorId: i.user.id, type: 'config_changed', payload: patch });
  const embed = new EmbedBuilder()
    .setTitle('Settings updated')
    .setDescription(`${describeConfig(toGuildConfig(row!))}\n\nBets already made, and mutes already won, keep the settings they started with.`)
    .setColor(COLORS.active);
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
}

async function repair(app: App, i: Command) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.guild.members.fetchMe({ force: true });
  const role = await ensureMarkerRole(app, i.guild);
  await i.editReply({ embeds: [setupEmbed(buildSetupReport(i.guild, role), 'MuteBetBot setup check')], allowedMentions: onlyUsers() });
}

async function uninstall(app: App, i: Command) {
  if (!i.options.getBoolean('confirm', true)) throw new UserError('Set `confirm:true` to uninstall.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const running = await runningMutesForGuild(app.db, i.guildId);
  for (const m of running) await finalizeMute(app, m.id, 'uninstall', i.user.id);
  const row = await guildRow(app, i.guildId);
  if (row.markerRoleId) {
    await i.guild.roles.delete(row.markerRoleId, `MuteBetBot uninstalled by ${i.user.tag}`).catch((e: unknown) => {
      app.log.warn({ err: e, guildId: i.guildId }, 'could not delete marker role');
    });
    await setMarkerRole(app.db, i.guildId, null);
  }
  await markGuildRemoved(app.db, i.guildId);
  await logEvent(app.db, { guildId: i.guildId, entity: 'guild', entityId: i.guildId, actorId: i.user.id, type: 'uninstalled' });
  const lifted = running.length === 1 ? '1 bet-mute' : `${running.length} bet-mutes`;
  await i.editReply(`Lifted ${lifted} and removed the marker role. Server data is kept for 30 days in case you add the bot back.`);
  await i.guild.leave();
}

async function execute(app: App, i: Command) {
  const config = await guildConfig(app, i.guildId);
  if (!isBotAdmin(memberAuthority(i.member), config.adminRoleId)) {
    throw new UserError('Admin commands need Manage Server or the configured admin role.');
  }
  const group = i.options.getSubcommandGroup();
  const sub = i.options.getSubcommand();
  if (group === 'config') {
    if (sub === 'view') {
      const embed = new EmbedBuilder().setTitle('MuteBetBot settings').setDescription(describeConfig(config)).setColor(COLORS.proposed);
      return void (await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() }));
    }
    return configSet(app, i);
  }
  switch (sub) {
    case 'rule':
      return rule(app, i);
    case 'unmute': {
      const user = i.options.getUser('user', true);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await adminUnmute(app, i.guildId, user.id, i.user.id);
      return void (await i.editReply({ content: `Lifted ${mention(user.id)}'s bet-mute.`, allowedMentions: onlyUsers() }));
    }
    case 'grant':
      return grant(app, i, config);
    case 'revoke': {
      const token = await revokeToken(app, await wonMuteFromOption(app, i), i.user.id);
      return void (await i.reply({ content: `Cancelled ${mention(token.holderId)}'s mute on ${mention(token.targetId)}.`, flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() }));
    }
    case 'repair':
      return repair(app, i);
    case 'uninstall':
      return uninstall(app, i);
    default:
      throw new UserError('Unknown subcommand.');
  }
}

async function autocomplete(app: App, i: Autocomplete) {
  const focused = i.options.getFocused(true);
  const query = focused.value;
  if (focused.name === 'duration') return respondWithDurations(app, i, query);
  if (i.options.getSubcommand() === 'revoke') {
    const now = new Date();
    const rows = await listWonMutes(app.db, i.guildId, { statuses: ['available', 'queued'], query, userIds: memberIdsMatching(i.guild, query) });
    return i.respond(
      rows
        .filter(({ token }) => !isTokenExpired(token, now))
        .map(({ token, bet }) => {
          const waiting = token.status === 'queued' ? ', waiting' : '';
          const head = `${nameOf(i.guild, token.holderId)} can mute ${nameOf(i.guild, token.targetId)}${waiting}`;
          return { name: withTerms(head, wonMuteOrigin(i.guild, token, bet)), value: wonMuteValue(token, bet) };
        })
        .slice(0, 25),
    );
  }
  const bets = await searchBets(app.db, i.guildId, {
    query,
    userIds: memberIdsMatching(i.guild, query),
    statuses: ['active', 'claim_pending', 'disputed'],
  });
  await i.respond(bets.map((b) => ({ name: betChoiceLabel(i.guild, b), value: b.shortId })));
}

export const mutebetCommand: CommandModule = { name: 'mutebet', execute, autocomplete };
