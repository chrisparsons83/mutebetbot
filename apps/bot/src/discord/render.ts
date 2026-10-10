import type { BetRow, ClaimRow, EventRow, MuteRow, TokenRow } from '@mutebetbot/db';
import { formatDuration, type BetStatus } from '@mutebetbot/shared';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type APIEmbedField, type MessageCreateOptions } from 'discord.js';
import { otherParty } from '../domain/bets.ts';
import { isTokenExpired } from '../domain/mutes.ts';
import { betClaim, mention, onlyUsers, ts } from './util.ts';

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
  useMute: (tokenId: string) => `mute:use:${tokenId}`,
  queueMute: (tokenId: string) => `mute:queue:${tokenId}`,
};

/** The prediction as a sentence. It's user text, but allowedMentions keeps it from pinging anyone. */
export const betSentence = (bet: Pick<BetRow, 'challengerId' | 'terms'>) => `${mention(bet.challengerId)} bets that ${betClaim(bet.terms)}.`;

/** Extra state the bet card shows once it exists. */
export interface BetCardExtra {
  claim?: ClaimRow | undefined;
  token?: TokenRow | undefined;
  mute?: MuteRow | undefined;
  /** The loser's display name, for the Mute button (buttons can't render mentions). */
  loserName?: string | undefined;
}

const BET_TITLE: Record<BetStatus, string> = {
  proposed: 'Open bet',
  active: 'Accepted',
  claim_pending: 'Result claimed',
  disputed: 'Disputed',
  resolved: 'Settled',
  void: 'Called off',
  declined: 'Declined',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const accepted = (d: Date | null) => (d ? 'Accepted' : 'Not yet');

/** One line for an open claim, naming who has to answer it and by when. */
function claimLine(bet: BetRow, claim: ClaimRow): string {
  const responder = claim.claimantId === bet.challengerId ? bet.opponentId : bet.challengerId;
  const what =
    claim.kind === 'void'
      ? 'wants to call it off'
      : claim.kind === 'win'
        ? 'says they won'
        : `says ${mention(responder)} won`;
  return `${mention(claim.claimantId)} ${what}. ${mention(responder)} has until ${ts(claim.respondBy, 'f')} to confirm or dispute.`;
}

/** Where the won mute stands, for a resolved bet. Undefined when there's nothing worth saying. */
function muteField(token: TokenRow, mute: MuteRow | undefined, now: Date): APIEmbedField | undefined {
  if (token.status === 'available' && !isTokenExpired(token, now)) {
    return token.expiresAt ? { name: 'Use by', value: `${ts(token.expiresAt, 'D')} (${ts(token.expiresAt, 'R')})` } : undefined;
  }
  const value = {
    available: 'Expired without being used',
    expired: 'Expired without being used',
    queued: 'Waiting in line. It starts when a slot opens.',
    active:
      mute?.status === 'paused'
        ? 'Paused until they come back to the server'
        : mute
          ? `Muted until ${ts(mute.endsAt, 't')} (${ts(mute.endsAt, 'R')})`
          : 'Muted',
    completed: 'Served',
    revoked: 'Cancelled by an admin',
  }[token.status];
  return { name: 'Mute', value };
}

/** The public bet message: its embed and whichever buttons apply right now. */
export function renderBetMessage(bet: BetRow, extra: BetCardExtra = {}, now = new Date()) {
  const notes: string[] = [];
  const stakes = { name: 'Stakes', value: `${formatDuration(bet.durationS)} mute`, inline: true };
  let fields: APIEmbedField[] = [
    { name: 'Challenger', value: mention(bet.challengerId), inline: true },
    { name: 'Opponent', value: mention(bet.opponentId), inline: true },
    stakes,
  ];
  switch (bet.status) {
    case 'proposed':
      fields = [
        { name: 'Challenger', value: `${mention(bet.challengerId)}\n${accepted(bet.challengerAcceptedAt)}`, inline: true },
        { name: 'Opponent', value: `${mention(bet.opponentId)}\n${accepted(bet.opponentAcceptedAt)}`, inline: true },
        stakes,
        { name: 'Accept by', value: `${ts(bet.acceptBy, 'f')} (${ts(bet.acceptBy, 'R')})` },
      ];
      break;
    case 'active':
      notes.push("When it's decided, either of you can run `/bet resolve`.");
      break;
    case 'claim_pending':
      if (extra.claim) notes.push(claimLine(bet, extra.claim));
      break;
    case 'disputed':
      notes.push('An admin will decide it with `/mutebet rule`.');
      break;
    case 'resolved':
      if (bet.winnerId) {
        fields = [
          { name: 'Winner', value: mention(bet.winnerId), inline: true },
          { name: 'Loser', value: mention(otherParty(bet, bet.winnerId)), inline: true },
          stakes,
        ];
        const field = extra.token && muteField(extra.token, extra.mute, now);
        if (field) fields.push(field);
      }
      break;
    case 'void':
    case 'declined':
    case 'expired':
    case 'cancelled':
      break;
  }
  const embed = new EmbedBuilder()
    .setTitle(BET_TITLE[bet.status])
    .setDescription([betSentence(bet), ...notes].join('\n\n'))
    .addFields(fields)
    .setColor(STATUS_COLOR[bet.status])
    .setTimestamp(bet.createdAt);

  if (bet.status === 'proposed') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(customId.accept(bet.id)).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(customId.decline(bet.id)).setLabel('Decline').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(customId.cancel(bet.id)).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [row] };
  }
  const token = extra.token;
  if (bet.status === 'resolved' && token?.status === 'available' && !isTokenExpired(token, now)) {
    const label = extra.loserName ? `Mute ${extra.loserName}` : 'Mute the loser';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(customId.useMute(token.id)).setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Primary),
    );
    return { embeds: [embed], components: [row] };
  }
  return { embeds: [embed], components: [] };
}

/** The DM sent to the other party when a claim or void is opened. */
export function renderClaimDm(bet: BetRow, claim: ClaimRow, guildName: string, disabledNote?: string): MessageCreateOptions {
  const what =
    claim.kind === 'void'
      ? `${mention(claim.claimantId)} wants to call off the bet.`
      : claim.kind === 'win'
        ? `${mention(claim.claimantId)} says they won.`
        : `${mention(claim.claimantId)} says you won.`;
  const ifIgnored = claim.kind === 'void' ? 'If you do nothing, the bet stays on.' : 'If you do nothing, an admin decides.';
  const embed = new EmbedBuilder()
    .setTitle(`Bet in ${guildName}`)
    .setDescription([betSentence(bet), what, disabledNote ?? `Answer by ${ts(claim.respondBy, 'f')}. ${ifIgnored}`].join('\n\n'))
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
  activated: 'Both accepted',
  declined: 'declined',
  cancelled: 'cancelled',
  expired: 'Nobody accepted in time',
  claim_opened: 'claimed a result',
  void_proposed: 'proposed calling it off',
  confirmed: 'confirmed',
  disputed: 'disputed',
  void_rejected: 'kept the bet on',
  void_lapsed: 'Call-off request went unanswered',
  claim_timed_out: 'Claim went unanswered, so it went to an admin',
  ruled: 'ruled',
  resolved: 'Settled',
  voided: 'Called off',
};

export function renderBetInfo(bet: BetRow, history: EventRow[], extra: BetCardExtra): EmbedBuilder {
  const { embeds } = renderBetMessage(bet, extra);
  const lines = history.slice(-20).map((e) => {
    const label = EVENT_LABEL[e.type] ?? e.type.replace(/_/g, ' ');
    const who = e.actorId ? `${mention(e.actorId)} ` : '';
    const reason = typeof e.payload.reason === 'string' && e.payload.reason ? ` ("${e.payload.reason}")` : '';
    return `${ts(e.at, 'f')}\n${who}${label}${reason}`;
  });
  const embed = embeds[0]!;
  if (lines.length) embed.addFields({ name: 'History', value: lines.join('\n\n').slice(0, 1024) });
  return embed;
}

export function describeMute(m: MuteRow): string {
  return m.kind === 'honor' ? `${mention(m.targetId)} on an honor mute until ${ts(m.endsAt, 't')}` : `${mention(m.targetId)} until ${ts(m.endsAt, 't')}`;
}
