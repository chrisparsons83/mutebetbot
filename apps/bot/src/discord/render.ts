import type { BetRow, ClaimRow, EventRow, MuteRow, TokenRow } from '@mutebetbot/db';
import { formatDuration, type BetStatus } from '@mutebetbot/shared';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import { mention, onlyUsers, ts } from './util.ts';

export const COLORS = {
  proposed: 0x5865f2,
  active: 0x57f287,
  pending: 0xf0b232,
  disputed: 0xed4245,
  done: 0x99aab5,
  muted: 0x2b2d31,
} as const;

export const STATUS_LABEL: Record<BetStatus, string> = {
  proposed: 'Proposed',
  active: 'Active',
  claim_pending: 'Claim pending',
  disputed: 'Disputed',
  resolved: 'Resolved',
  void: 'Void',
  declined: 'Declined',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<BetStatus, number> = {
  proposed: COLORS.proposed,
  active: COLORS.active,
  claim_pending: COLORS.pending,
  disputed: COLORS.disputed,
  resolved: COLORS.done,
  void: COLORS.done,
  declined: COLORS.done,
  expired: COLORS.done,
  cancelled: COLORS.done,
};

/** Custom IDs carry the record ID; handlers re-check everything server-side. */
export const customId = {
  accept: (betId: string) => `bet:accept:${betId}`,
  decline: (betId: string) => `bet:decline:${betId}`,
  cancel: (betId: string) => `bet:cancel:${betId}`,
  confirm: (claimId: string) => `claim:confirm:${claimId}`,
  dispute: (claimId: string) => `claim:dispute:${claimId}`,
};

/** Terms are user text: shown in a quote block, never able to ping (allowedMentions does the rest). */
export function quoteTerms(terms: string): string {
  return terms
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

const check = (d: Date | null) => (d ? '✅' : '⏳');

/** The public bet message: its embed and (while Proposed) the Accept / Decline / Cancel buttons. */
export function renderBetMessage(bet: BetRow, extra?: { claim?: ClaimRow | undefined; token?: TokenRow | undefined }) {
  const lines = [
    `${mention(bet.challengerId)} vs ${mention(bet.opponentId)}`,
    quoteTerms(bet.terms),
    `**Stakes:** loser is muted for **${formatDuration(bet.durationS)}**`,
  ];
  switch (bet.status) {
    case 'proposed':
      lines.push(
        `${check(bet.challengerAcceptedAt)} ${mention(bet.challengerId)}  ${check(bet.opponentAcceptedAt)} ${mention(bet.opponentId)}`,
        `Both must click **🤝 Accept** by ${ts(bet.acceptBy, 'f')} (${ts(bet.acceptBy, 'R')}).`,
      );
      break;
    case 'active':
      lines.push('🤝 Both accepted. Settle it with `/bet resolve` (or `/bet void`).');
      break;
    case 'claim_pending':
      if (extra?.claim) {
        const what = extra.claim.kind === 'void' ? 'proposed calling it off' : `says ${extra.claim.kind === 'win' ? 'they' : 'the other side'} won`;
        lines.push(`⏳ ${mention(extra.claim.claimantId)} ${what}. Waiting for confirmation until ${ts(extra.claim.respondBy, 'f')}.`);
      }
      break;
    case 'disputed':
      lines.push('⚖️ Disputed. An admin will rule with `/mutebet rule`.');
      break;
    case 'resolved':
      if (bet.winnerId) {
        const loser = bet.winnerId === bet.challengerId ? bet.opponentId : bet.challengerId;
        lines.push(`🏆 ${mention(bet.winnerId)} won. ${mention(loser)} owes **${formatDuration(bet.durationS)}** of silence.`);
        if (extra?.token) lines.push(`Token **${extra.token.shortId}**: redeem with \`/mute redeem token:${extra.token.shortId}\`.`);
      }
      break;
    case 'void':
      lines.push('🤷 Called off. No token issued.');
      break;
    case 'declined':
      lines.push(`${mention(bet.opponentId)} declined.`);
      break;
    case 'expired':
      lines.push('⌛ Expired: not accepted within 48 hours.');
      break;
    case 'cancelled':
      lines.push('Cancelled by the challenger.');
      break;
  }
  const embed = new EmbedBuilder()
    .setTitle(`Bet ${bet.shortId} · ${STATUS_LABEL[bet.status]}`)
    .setDescription(lines.join('\n'))
    .setColor(STATUS_COLOR[bet.status])
    .setTimestamp(bet.createdAt);
  const open = bet.status === 'proposed';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId.accept(bet.id)).setLabel('Accept').setEmoji('🤝').setStyle(ButtonStyle.Success).setDisabled(!open),
    new ButtonBuilder().setCustomId(customId.decline(bet.id)).setLabel('Decline').setStyle(ButtonStyle.Secondary).setDisabled(!open),
    new ButtonBuilder().setCustomId(customId.cancel(bet.id)).setLabel('Cancel').setStyle(ButtonStyle.Danger).setDisabled(!open),
  );
  return { embeds: [embed], components: open ? [row] : [] };
}

/** The DM sent to the other party when a claim or void is opened. */
export function renderClaimDm(bet: BetRow, claim: ClaimRow, guildName: string, disabledNote?: string): MessageCreateOptions {
  const what =
    claim.kind === 'void'
      ? `${mention(claim.claimantId)} wants to **call off** the bet.`
      : claim.kind === 'win'
        ? `${mention(claim.claimantId)} says **they won**.`
        : `${mention(claim.claimantId)} says **you won**.`;
  const embed = new EmbedBuilder()
    .setTitle(`Bet ${bet.shortId} in ${guildName}`)
    .setDescription(
      [
        quoteTerms(bet.terms),
        what,
        disabledNote ??
          `Confirm or dispute by ${ts(claim.respondBy, 'f')}. ${claim.kind === 'void' ? 'If you do nothing, the bet stays on.' : 'If you do nothing, it goes to an admin.'}`,
      ].join('\n'),
    )
    .setColor(COLORS.pending);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId.confirm(claim.id)).setLabel('Confirm').setStyle(ButtonStyle.Success).setDisabled(Boolean(disabledNote)),
    new ButtonBuilder().setCustomId(customId.dispute(claim.id)).setLabel(claim.kind === 'void' ? 'Keep the bet on' : 'Dispute').setStyle(ButtonStyle.Danger).setDisabled(Boolean(disabledNote)),
  );
  return { embeds: [embed], components: [row], allowedMentions: onlyUsers() };
}

const EVENT_LABEL: Record<string, string> = {
  created: 'proposed the bet',
  accepted: 'accepted',
  activated: 'Bet became active',
  declined: 'declined',
  cancelled: 'cancelled',
  expired: 'Proposal expired',
  claim_opened: 'claimed a result',
  void_proposed: 'proposed calling it off',
  confirmed: 'confirmed',
  disputed: 'disputed',
  void_rejected: 'kept the bet on',
  void_lapsed: 'Void proposal lapsed',
  claim_timed_out: 'Claim went unanswered; disputed',
  ruled: 'ruled',
  resolved: 'Bet resolved',
  voided: 'Bet voided',
};

export function renderBetInfo(bet: BetRow, history: EventRow[], token: TokenRow | undefined): EmbedBuilder {
  const { embeds } = renderBetMessage(bet, { token });
  const lines = history.slice(-20).map((e) => {
    const label = EVENT_LABEL[e.type] ?? e.type.replace(/_/g, ' ');
    const who = e.actorId ? `${mention(e.actorId)} ` : '';
    const reason = typeof e.payload.reason === 'string' && e.payload.reason ? `: “${e.payload.reason}”` : '';
    return `${ts(e.at, 'f')} ${who}${label}${reason}`;
  });
  const embed = embeds[0]!;
  if (lines.length) embed.addFields({ name: 'History', value: lines.join('\n').slice(0, 1024) });
  if (token) embed.addFields({ name: 'Token', value: `${token.shortId} · ${token.status}`, inline: true });
  return embed;
}

export function describeMute(m: MuteRow): string {
  const kind = m.kind === 'honor' ? ' (honor mute)' : '';
  return `${mention(m.targetId)}${kind}: ends ${ts(m.endsAt, 'R')}`;
}
