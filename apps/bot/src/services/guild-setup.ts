import {
  getGuild,
  listInstalledGuildIds,
  logEvent,
  markGuildRemoved,
  setMarkerRole,
  upsertGuild,
  type GuildRow,
} from '@mutebetbot/db';
import { MARKER_ROLE_NAME } from '@mutebetbot/shared';
import { EmbedBuilder, PermissionFlagsBits, type Guild, type Role } from 'discord.js';
import type { App } from '../context.ts';
import { botTopPosition, sendableChannel } from '../discord/util.ts';

export const UNINSTALL_NOTE = 'Use `/mutebet uninstall` before removing the bot to clean up its role.';

const REQUIRED_PERMISSIONS = [
  ['ModerateMembers', 'Moderate Members', 'apply and clear timeouts'],
  ['ManageRoles', 'Manage Roles', 'create and assign the marker role'],
  ['ViewChannel', 'View Channels', 'see channels'],
  ['SendMessages', 'Send Messages', 'post bets and announcements'],
  ['EmbedLinks', 'Embed Links', 'post bet embeds'],
  ['ReadMessageHistory', 'Read Message History', 'reply to honor-muted members'],
] as const;
const OPTIONAL_PERMISSIONS = [['ViewAuditLog', 'View Audit Log', 'notice when a moderator lifts a bet-mute']] as const;

/**
 * Returns the marker role, adopting the stored one if it still exists, else creating it.
 * After creation the bot never touches its name, color, hoist, or icon; it tracks it by ID.
 */
export async function ensureMarkerRole(app: App, guild: Guild, row?: GuildRow): Promise<Role | null> {
  const stored = row ?? (await getGuild(app.db, guild.id));
  if (stored?.markerRoleId) {
    const existing = guild.roles.cache.get(stored.markerRoleId) ?? (await guild.roles.fetch(stored.markerRoleId).catch(() => null));
    if (existing) return existing;
  }
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) return null;
  try {
    const role = await guild.roles.create({
      name: MARKER_ROLE_NAME,
      permissions: [],
      mentionable: false,
      hoist: true,
      reason: 'MuteBetBot marker role for bet-muted members',
    });
    await setMarkerRole(app.db, guild.id, role.id);
    await logEvent(app.db, { guildId: guild.id, entity: 'guild', entityId: guild.id, type: 'marker_role_created', payload: { roleId: role.id } });
    return role;
  } catch (e) {
    app.log.warn({ err: e, guildId: guild.id }, 'could not create marker role');
    return null;
  }
}

export interface SetupReport {
  missing: string[];
  missingOptional: string[];
  markerRole: Role | null;
  markerRoleAboveBot: boolean;
  /** Roles at or above the bot's top role; their members can only get honor mutes. */
  rolesAboveBot: Role[];
}

export function buildSetupReport(guild: Guild, markerRole: Role | null): SetupReport {
  const me = guild.members.me;
  const perms = me?.permissions;
  const missing = REQUIRED_PERMISSIONS.filter(([flag]) => !perms?.has(PermissionFlagsBits[flag])).map(
    ([, label, why]) => `**${label}** (to ${why})`,
  );
  const missingOptional = OPTIONAL_PERMISSIONS.filter(([flag]) => !perms?.has(PermissionFlagsBits[flag])).map(
    ([, label, why]) => `**${label}** (to ${why})`,
  );
  const top = botTopPosition(guild);
  const rolesAboveBot = guild.roles.cache
    .filter((r) => r.position >= top && r.id !== me?.roles.highest.id && !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => r);
  return {
    missing,
    missingOptional,
    markerRole,
    markerRoleAboveBot: markerRole ? markerRole.position >= top : false,
    rolesAboveBot,
  };
}

export function setupEmbed(report: SetupReport, title = 'MuteBetBot is ready'): EmbedBuilder {
  const permissions = report.missing.length ? `Missing: ${report.missing.join(', ')}.` : 'All set.';
  const optional = report.missingOptional.length ? `\nOptional, not granted: ${report.missingOptional.join(', ')}.` : '';
  const marker = !report.markerRole
    ? "I couldn't create it. Grant Manage Roles, then run `/mutebet repair`."
    : report.markerRoleAboveBot
      ? `${report.markerRole.toString()} sits above my role, so I can't assign it. Move it below my role.`
      : `${report.markerRole.toString()}. Rename or restyle it however you like.`;
  const fields = [
    { name: 'Permissions', value: permissions + optional },
    { name: 'Marker role', value: marker },
  ];
  if (report.rolesAboveBot.length) {
    const names = report.rolesAboveBot.slice(0, 10).map((r) => r.toString()).join(', ');
    fields.push({
      name: 'Role order',
      value:
        `Members with ${names}${report.rolesAboveBot.length > 10 ? ' and others' : ''} are above my role, so they can only get honor mutes. ` +
        'To fix it, drag my role above theirs in Server Settings > Roles.',
    });
  }
  fields.push({ name: 'Settings', value: `See and change them with \`/mutebet config view\` and \`/mutebet config set\`. ${UNINSTALL_NOTE}` });
  return new EmbedBuilder()
    .setTitle(title)
    .addFields(fields)
    .setColor(report.missing.length ? 0xf0b232 : 0x57f287);
}

/** Guild create: upsert the row, make or adopt the marker role, post the setup embed if possible. */
export async function installGuild(app: App, guild: Guild): Promise<void> {
  const existed = await getGuild(app.db, guild.id);
  const row = await upsertGuild(app.db, guild.id);
  await logEvent(app.db, { guildId: guild.id, entity: 'guild', entityId: guild.id, type: existed ? 'reinstalled' : 'installed' });
  const role = await ensureMarkerRole(app, guild, row);
  const channel = await sendableChannel(guild, guild.systemChannelId);
  if (channel) {
    await channel
      .send({ embeds: [setupEmbed(buildSetupReport(guild, role))], allowedMentions: { parse: [] } })
      .catch((e: unknown) => app.log.warn({ err: e, guildId: guild.id }, 'could not post setup embed'));
  }
  app.log.info({ guildId: guild.id, reinstall: Boolean(existed) }, 'guild installed');
}

/** Guild delete (kicked or uninstalled): soft-delete; data is purged after 30 days. */
export async function removeGuild(app: App, guildId: string): Promise<void> {
  if (!(await getGuild(app.db, guildId))) return;
  await markGuildRemoved(app.db, guildId);
  await logEvent(app.db, { guildId, entity: 'guild', entityId: guildId, type: 'removed' });
  app.scheduler.cancelGuild(guildId);
  app.honorTargets.delete(guildId);
  app.log.info({ guildId }, 'guild removed');
}

/** Startup: install guilds joined while offline; soft-delete ones we were removed from. */
export async function syncGuilds(app: App): Promise<void> {
  const known = new Set(await listInstalledGuildIds(app.db));
  for (const guild of app.client.guilds.cache.values()) {
    const row = await getGuild(app.db, guild.id);
    if (!row || row.removedAt) await installGuild(app, guild);
    known.delete(guild.id);
  }
  // With shards, other shards' guilds aren't in this cache; only a single process can tell.
  if (app.client.shard) return;
  for (const guildId of known) await removeGuild(app, guildId);
}
