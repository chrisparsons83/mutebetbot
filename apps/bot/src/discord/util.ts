import {
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type SendableChannels,
  type User,
} from 'discord.js';
import type { MemberAuthority } from '../domain/members.ts';
import { isMutableBy } from '../domain/members.ts';

/** An expected failure whose message is safe to show the user (ephemeral). */
export class UserError extends Error {
  override name = 'UserError';
}

export const mention = (id: string) => `<@${id}>`;
export const roleMention = (id: string) => `<@&${id}>`;
/** Discord timestamp markup; renders in each viewer's timezone. */
export const ts = (d: Date, style: 'R' | 'f' | 'F' | 't' | 'd' = 'f') => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;

/** Only these users may be pinged by a message. Everything else is inert text. */
export const onlyUsers = (...ids: (string | null | undefined)[]) => ({
  parse: [] as never[],
  users: [...new Set(ids.filter((x): x is string => Boolean(x)))],
  roles: [] as string[],
  repliedUser: false,
});

export function isDiscordError(e: unknown, ...codes: (number | string)[]): e is DiscordAPIError {
  return e instanceof DiscordAPIError && codes.includes(e.code);
}

/** The member, or null if they aren't in the server. */
export async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId);
  } catch (e) {
    if (isDiscordError(e, RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser)) return null;
    throw e;
  }
}

export function botTopPosition(guild: Guild): number {
  return guild.members.me?.roles.highest.position ?? 0;
}

export function memberAuthority(member: GuildMember): MemberAuthority {
  return {
    id: member.id,
    isOwner: member.guild.ownerId === member.id,
    isAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
    hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    roleIds: [...member.roles.cache.keys()],
    highestRolePosition: member.roles.highest.position,
  };
}

/** Whether the bot can time this member out (else they get an honor mute). */
export function isMutable(member: GuildMember): boolean {
  return isMutableBy(memberAuthority(member), botTopPosition(member.guild));
}

/** The member's current timeout end, if one is running. */
export function timeoutUntil(member: GuildMember): Date | null {
  const until = member.communicationDisabledUntil;
  return until && until.getTime() > Date.now() ? until : null;
}

/** DMs a user; returns null if their DMs are closed (50007) so callers can fall back to a channel ping. */
export async function tryDm(user: User, payload: MessageCreateOptions) {
  try {
    return await user.send(payload);
  } catch (e) {
    if (isDiscordError(e, RESTJSONErrorCodes.CannotSendMessagesToThisUser)) return null;
    throw e;
  }
}

/** A channel the bot can post in, if the ID resolves and it has send permission. */
export async function sendableChannel(guild: Guild, channelId: string | null | undefined): Promise<SendableChannels | null> {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isSendable() || !('permissionsFor' in channel)) return null;
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return null;
  }
  return channel;
}
