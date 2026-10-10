/** Facts about a guild member, extracted from discord.js so the rules stay pure. */
export interface MemberAuthority {
  id: string;
  isOwner: boolean;
  isAdministrator: boolean;
  hasManageGuild: boolean;
  roleIds: readonly string[];
  /** Position of the member's highest role (0 = @everyone). */
  highestRolePosition: number;
}

/** Discord won't let a bot time out administrators, the owner, or anyone at or above its top role. */
export function isMutableBy(member: MemberAuthority, botHighestRolePosition: number): boolean {
  if (member.isOwner || member.isAdministrator) return false;
  return member.highestRolePosition < botHighestRolePosition;
}

/** Admin commands: Manage Server, or the configured admin role. */
export function isBotAdmin(member: MemberAuthority, adminRoleId: string | null): boolean {
  if (member.isOwner || member.isAdministrator || member.hasManageGuild) return true;
  return adminRoleId !== null && member.roleIds.includes(adminRoleId);
}
