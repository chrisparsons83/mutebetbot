/** Discord permission bits the bot requests on invite. See DESIGN.md › Permissions. */
export const PERMISSION_BITS = {
  ViewAuditLog: 1n << 7n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  ReadMessageHistory: 1n << 16n,
  ManageRoles: 1n << 28n,
  ModerateMembers: 1n << 40n,
} as const;

export const BOT_PERMISSIONS: bigint = Object.values(PERMISSION_BITS).reduce((a, b) => a | b, 0n);

export const INVITE_SCOPES = ['bot', 'applications.commands'] as const;

export function inviteUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: INVITE_SCOPES.join(' '),
    permissions: BOT_PERMISSIONS.toString(),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export const SUPPORT_LINKS = {
  issues: 'https://github.com/chrisparsons83/mutebetbot/issues',
  supportServer: null as string | null,
};
