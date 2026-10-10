import { logEvent, markGuildRemoved, runningMutesForGuild, searchBets, searchTokens, setMarkerRole, toGuildConfig, updateGuildConfig } from '@mutebetbot/db';
import { formatDuration, type GuildConfig } from '@mutebetbot/shared';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { App } from '../context.ts';
import { explain } from '../copy.ts';
import { planAdminRule } from '../domain/bets.ts';
import { parseConfigSet } from '../domain/config.ts';
import { isBotAdmin } from '../domain/members.ts';
import { COLORS } from '../discord/render.ts';
import { memberAuthority, mention, onlyUsers, UserError } from '../discord/util.ts';
import { adminRule } from '../services/bets.ts';
import { buildSetupReport, ensureMarkerRole, setupEmbed } from '../services/guild-setup.ts';
import { adminUnmute, finalizeMute, revokeToken } from '../services/mutes.ts';
import { betFromOption, clip, guildConfig, guildRow, nameOf, tokenFromOption, type Autocomplete, type Command, type CommandModule } from './common.ts';

function describeConfig(c: GuildConfig): string {
  return [
    `**max_concurrent_mutes:** ${c.maxConcurrentMutes}`,
    `**token_expiry:** ${c.tokenExpiry}`,
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
  await i.editReply(r.bet.status === 'void' ? `Bet **${bet.shortId}** voided.` : `Bet **${bet.shortId}** resolved for ${mention(r.bet.winnerId!)}.`);
}

async function configSet(app: App, i: Command) {
  const o = i.options;
  const { patch, errors } = parseConfigSet({
    max_concurrent_mutes: o.getInteger('max_concurrent_mutes'),
    token_expiry: o.getString('token_expiry'),
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
    .setDescription(`${describeConfig(toGuildConfig(row!))}\n\nChanges apply to new bets and tokens; existing ones keep their terms.`)
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
  await i.editReply(`Lifted ${running.length} bet-mute(s) and removed the marker role. Goodbye! Data is kept for 30 days in case you re-add the bot.`);
  await i.guild.leave();
}

async function execute(app: App, i: Command) {
  const config = await guildConfig(app, i.guildId);
  if (!isBotAdmin(memberAuthority(i.member), config.adminRoleId)) {
    throw new UserError('Admin commands need **Manage Server** or the configured admin role.');
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
    case 'revoke': {
      const token = await revokeToken(app, await tokenFromOption(app, i), i.user.id);
      return void (await i.reply({ content: `Token **${token.shortId}** revoked.`, flags: MessageFlags.Ephemeral }));
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
  const prefix = i.options.getFocused().trim().toUpperCase();
  if (i.options.getSubcommand() === 'revoke') {
    const rows = await searchTokens(app.db, i.guildId, { prefix, statuses: ['available', 'queued'] });
    return i.respond(
      rows.map((t) => ({ name: clip(`${t.shortId} · ${nameOf(i.guild, t.holderId)} → ${nameOf(i.guild, t.targetId)} · ${t.status}`, 100), value: t.shortId })),
    );
  }
  const bets = await searchBets(app.db, i.guildId, { prefix, statuses: ['active', 'claim_pending', 'disputed'] });
  await i.respond(
    bets.map((b) => ({ name: clip(`${b.shortId} · ${nameOf(i.guild, b.challengerId)} vs ${nameOf(i.guild, b.opponentId)} · ${b.terms}`, 100), value: b.shortId })),
  );
}

export const mutebetCommand: CommandModule = { name: 'mutebet', execute, autocomplete };
