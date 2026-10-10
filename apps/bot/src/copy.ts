import type { BetStatus, TokenStatus } from '@mutebetbot/shared';
import type { Blocker } from './domain/mutes.ts';
import { STATUS_LABEL } from './discord/render.ts';
import { mention, ts } from './discord/util.ts';

/** User-facing text for every domain error code. Unknown codes fall back to a generic line. */
export function explain(e: { error: string } & Record<string, unknown>): string {
  switch (e.error) {
    case 'disabled':
      return 'MuteBetBot is paused in this server. New bets and mutes are off for now.';
    case 'self_bet':
      return "You can't bet against yourself.";
    case 'bot_opponent':
      return "You can't bet against a bot.";
    case 'opponent_not_member':
      return "That person isn't in this server.";
    case 'terms_empty':
      return 'Say what you think will happen, like "Oklahoma scores over 30.5 against Texas".';
    case 'terms_too_long':
      return `Keep the prediction to ${String(e.max)} characters.`;
    case 'duration_not_allowed':
      return `That duration isn't allowed here. Choose one of: ${(e.allowed as string[]).join(', ')}.`;
    case 'create_cooldown':
      return `You can propose another bet ${ts(e.retryAt as Date, 'R')}.`;
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
      return "That's your own claim. The other party has to answer it.";
    case 'admin_is_party':
      return "You're a party to this bet, so another admin has to rule on it.";
    case 'not_rulable':
      return `That bet is ${STATUS_LABEL[e.status as BetStatus].toLowerCase()}. Only active or disputed bets can be ruled on.`;
    case 'winner_not_party':
      return 'The winner must be one of the two people in the bet.';
    case 'not_holder':
      return 'Only the winner can use this mute.';
    case 'not_available':
      return wonMuteStatusText(e.status as TokenStatus);
    case 'target_absent':
      return "The loser isn't in the server right now. You still have the mute, so try again when they're back.";
    case 'target_unmutable':
      return "This server doesn't allow honor mutes, and the loser can't be timed out. You still have the mute.";
    case 'blocked':
      return blockerText(e.blocker as Blocker, 'command');
    default:
      return "That didn't work.";
  }
}

/** How the person can wait for a blocked mute: already queued, the `queue` option, or the Wait in line button. */
export type QueueHint = 'queued' | 'command' | 'button';

export function blockerText(b: Blocker, hint: QueueHint): string {
  const suffix = {
    queued: ' Your mute is in line and starts on its own.',
    command: ' You still have the mute. Add `queue:true` to wait in line.',
    button: ' You still have the mute, or you can wait in line.',
  }[hint];
  switch (b.reason) {
    case 'at_cap':
      return `The server is at its limit of people bet-muted at once.${b.soonestEnd ? ` The next one ends ${ts(b.soonestEnd, 'R')}.` : ''}${suffix}`;
    case 'target_muted':
      return `They're already bet-muted.${suffix}`;
    case 'target_cooldown':
      return `They were bet-muted recently and can be muted again ${ts(b.eligibleAt, 'R')}.${suffix}`;
  }
}

export function wonMuteStatusText(s: TokenStatus): string {
  return {
    available: 'That mute is ready to use.',
    queued: 'That mute is already waiting in line.',
    active: 'That mute is already running.',
    completed: 'That mute has already been used.',
    expired: 'That mute expired before it was used.',
    revoked: 'An admin cancelled that mute.',
  }[s];
}

/** The public line when a mute starts. */
export const mutedLine = (targetId: string, winnerId: string, endsAt: Date, honor: boolean) =>
  honor
    ? `${mention(targetId)} lost a bet to ${mention(winnerId)} and is on an honor mute until ${ts(endsAt, 't')}.`
    : `${mention(targetId)} lost a bet to ${mention(winnerId)} and is muted until ${ts(endsAt, 't')}.`;
