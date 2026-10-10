import { formatDuration, type BetStatus, type TokenStatus } from '@mutebetbot/shared';
import type { Blocker } from './domain/mutes.ts';
import { STATUS_LABEL } from './discord/render.ts';
import { mention, ts } from './discord/util.ts';

/** User-facing text for every domain error code. Unknown codes fall back to a generic line. */
export function explain(e: { error: string } & Record<string, unknown>): string {
  switch (e.error) {
    case 'disabled':
      return 'MuteBetBot is paused in this server: new bets and redemptions are off.';
    case 'self_bet':
      return "You can't bet against yourself.";
    case 'bot_opponent':
      return "You can't bet against a bot.";
    case 'opponent_not_member':
      return "That person isn't in this server.";
    case 'terms_empty':
      return 'Say what the bet is about.';
    case 'terms_too_long':
      return `Keep the terms to ${String(e.max)} characters.`;
    case 'duration_not_allowed':
      return `That duration isn't allowed here. Choose one of: ${(e.allowed as string[]).join(', ')}.`;
    case 'create_cooldown':
      return `Slow down: you can propose another bet ${ts(e.retryAt as Date, 'R')}.`;
    case 'too_many_proposals':
      return `You already have ${String(e.max)} proposals waiting. Cancel one or wait for them to be accepted.`;
    case 'unmutable_party':
      return `This server doesn't allow bets with members the bot can't time out (${(e.userIds as string[]).map(mention).join(', ')}).`;
    case 'not_party':
      return "This isn't your bet.";
    case 'expired':
      return 'That has expired.';
    case 'not_proposed':
      return `This bet is already ${STATUS_LABEL[e.status as BetStatus].toLowerCase()}.`;
    case 'already_accepted':
      return "You've already accepted. Waiting on the other side.";
    case 'challenger_cannot_decline':
      return 'Use **Cancel** to withdraw your own proposal.';
    case 'only_challenger_can_cancel':
      return 'Only the challenger can cancel. Use **Decline** instead.';
    case 'already_claimed':
      return 'You already have a claim waiting on the other party.';
    case 'not_claimable':
      return `You can't claim a result on a bet that's ${STATUS_LABEL[e.status as BetStatus].toLowerCase()}.`;
    case 'no_open_claim':
      return "There's nothing to confirm or dispute on that bet.";
    case 'own_claim':
      return "That's your own claim; the other party has to answer it.";
    case 'admin_is_party':
      return "You're a party to this bet, so another admin has to rule on it.";
    case 'not_rulable':
      return `That bet is ${STATUS_LABEL[e.status as BetStatus].toLowerCase()}; only active or disputed bets can be ruled.`;
    case 'winner_not_party':
      return 'The winner must be one of the two people in the bet.';
    case 'not_holder':
      return "That token isn't yours.";
    case 'not_available':
      return `That token is ${tokenStatusText(e.status as TokenStatus)}.`;
    case 'target_absent':
      return "The loser isn't in the server right now. Your token is kept; try again if they come back.";
    case 'target_unmutable':
      return "This server doesn't allow honor mutes, and the loser can't be timed out. Your token is kept.";
    case 'blocked':
      return blockerText(e.blocker as Blocker, false);
    default:
      return 'That didn’t work.';
  }
}

export function blockerText(b: Blocker, queued: boolean): string {
  const suffix = queued ? ' Your token is queued and will start automatically.' : ' Your token is kept. Add `queue:true` to wait in line.';
  switch (b.reason) {
    case 'at_cap':
      return `The server is at its limit of simultaneous bet-mutes${b.soonestEnd ? `; the next one ends ${ts(b.soonestEnd, 'R')}` : ''}.${suffix}`;
    case 'target_muted':
      return `They're already bet-muted.${suffix}`;
    case 'target_cooldown':
      return `They were bet-muted recently and can be muted again ${ts(b.eligibleAt, 'R')}.${suffix}`;
  }
}

export function tokenStatusText(s: TokenStatus): string {
  return { available: 'available', queued: 'queued', active: 'already in use', completed: 'already spent', expired: 'expired', revoked: 'revoked' }[s];
}

export const mutedLine = (targetId: string, durationS: number, endsAt: Date, honor: boolean) =>
  honor
    ? `🤐 ${mention(targetId)} lost a bet and is on an **honor mute** for ${formatDuration(durationS)} (until ${ts(endsAt, 't')}).`
    : `🔇 ${mention(targetId)} lost a bet and is muted for **${formatDuration(durationS)}** (until ${ts(endsAt, 't')}).`;
