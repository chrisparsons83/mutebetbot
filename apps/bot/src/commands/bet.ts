import {
  countProposedByChallenger,
  eventsFor,
  insertBet,
  listBets,
  logEvent,
  searchBets,
  setBetMessage,
} from '@mutebetbot/db';
import { formatDuration, MUTE_DURATIONS, OPEN_BET_STATUSES, type BetStatus } from '@mutebetbot/shared';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import type { App } from '../context.ts';
import { explain } from '../copy.ts';
import { validateCreate, type MemberFacts } from '../domain/bets.ts';
import { COLORS, renderBetInfo, renderBetMessage, STATUS_LABEL } from '../discord/render.ts';
import { betClaim, clip, isMutable, mention, nameOf, onlyUsers, theBet, UserError } from '../discord/util.ts';
import { betCardExtra, cancelBet, refreshBetMessage, respondToClaim, submitClaim } from '../services/bets.ts';
import { betChoiceLabel, betFromOption, guildConfig, memberIdsMatching, type Autocomplete, type Command, type CommandModule } from './common.ts';

const PAGE_SIZE = 10;

const STATUS_FILTERS: Record<string, readonly BetStatus[]> = {
  open: OPEN_BET_STATUSES,
  closed: ['declined', 'expired', 'cancelled'],
};

async function create(app: App, i: Command) {
  const config = await guildConfig(app, i.guildId);
  const opponentUser = i.options.getUser('opponent', true);
  const opponentMember = i.options.getMember('opponent');
  const now = new Date();
  const key = `${i.guildId}:${i.user.id}`;
  const facts = (id: string, isBot: boolean, member: typeof opponentMember): MemberFacts => ({
    id,
    isBot,
    inGuild: Boolean(member),
    mutable: member ? isMutable(member) : false,
  });
  const plan = validateCreate({
    challenger: facts(i.user.id, false, i.member),
    opponent: facts(opponentUser.id, opponentUser.bot, opponentMember),
    terms: i.options.getString('prediction', true),
    duration: i.options.getString('duration', true),
    config,
    openProposals: await countProposedByChallenger(app.db, i.guildId, i.user.id),
    lastCreateAt: app.lastCreateAt.get(key),
    now,
  });
  if (!plan.ok) throw new UserError(explain(plan));
  app.lastCreateAt.set(key, now);

  const bet = await insertBet(app.db, {
    guildId: i.guildId,
    challengerId: i.user.id,
    opponentId: opponentUser.id,
    terms: plan.terms,
    durationS: plan.durationS,
    channelId: i.channelId,
    acceptBy: plan.acceptBy,
    createdAt: now,
  });
  await logEvent(app.db, { guildId: i.guildId, entity: 'bet', entityId: bet.id, actorId: i.user.id, type: 'created' });
  const response = await i.reply({
    content: `${mention(opponentUser.id)}, ${mention(i.user.id)} challenges you to a bet.`,
    ...renderBetMessage(bet),
    allowedMentions: onlyUsers(opponentUser.id),
    withResponse: true,
  });
  const message = response.resource?.message;
  if (message) await setBetMessage(app.db, bet.id, message.channelId, message.id);
}

async function list(app: App, i: Command) {
  const user = i.options.getUser('user');
  const status = i.options.getString('status');
  const page = i.options.getInteger('page') ?? 1;
  const statuses = status ? (STATUS_FILTERS[status] ?? [status as BetStatus]) : undefined;
  const { rows, total } = await listBets(app.db, i.guildId, { userId: user?.id, statuses }, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const lines = rows.map(
    (b) =>
      `${mention(b.challengerId)} bets that ${clip(betClaim(b.terms), 80)}\nAgainst ${mention(b.opponentId)} for ${formatDuration(b.durationS)}, ${STATUS_LABEL[b.status].toLowerCase()}`,
  );
  const embed = new EmbedBuilder()
    .setTitle(user ? `Bets involving ${nameOf(i.guild, user.id)}` : 'Bets')
    .setDescription(lines.join('\n\n') || 'No bets found.')
    .setFooter({ text: `Page ${Math.min(page, pages)} of ${pages}, ${total} ${total === 1 ? 'bet' : 'bets'} in all` })
    .setColor(COLORS.proposed);
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
}

async function info(app: App, i: Command) {
  const bet = await betFromOption(app, i);
  const [history, extra] = await Promise.all([eventsFor(app.db, 'bet', bet.id), betCardExtra(app, bet)]);
  await i.reply({ embeds: [renderBetInfo(bet, history, extra)], flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
}

async function execute(app: App, i: Command) {
  const sub = i.options.getSubcommand();
  switch (sub) {
    case 'create':
      return create(app, i);
    case 'list':
      return list(app, i);
    case 'info':
      return info(app, i);
    case 'cancel': {
      const bet = await cancelBet(app, await betFromOption(app, i), i.user.id);
      await refreshBetMessage(app, bet.id);
      return void (await i.reply({ content: `Cancelled ${theBet(bet.terms)}.`, flags: MessageFlags.Ephemeral }));
    }
    case 'resolve':
    case 'void': {
      const kind = sub === 'void' ? 'void' : (i.options.getString('outcome', true) as 'win' | 'lose');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await submitClaim(app, await betFromOption(app, i), i.user.id, kind);
      const msg = {
        opened: `Sent to the other party to confirm. If they don't answer in time, ${kind === 'void' ? 'the bet stays on' : 'an admin decides'}.`,
        resolved: 'They had already said the same thing, so the bet is settled.',
        disputed: 'They had claimed the opposite, so the bet is disputed. Admins have been told.',
      }[r.kind];
      return void (await i.editReply(msg));
    }
    case 'confirm':
    case 'dispute': {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const reason = sub === 'dispute' ? (i.options.getString('reason') ?? undefined) : undefined;
      const r = await respondToClaim(app, await betFromOption(app, i), i.user.id, sub, reason);
      const msg = { resolved: 'Confirmed. The bet is settled.', disputed: 'Disputed. Admins have been told.', opened: 'The bet stays on.' }[r.kind];
      return void (await i.editReply(msg));
    }
    default:
      throw new UserError('Unknown subcommand.');
  }
}

/** Which bets each subcommand's autocomplete offers. */
const AUTOCOMPLETE_SCOPE: Record<string, { statuses?: BetStatus[]; mine: boolean }> = {
  cancel: { statuses: ['proposed'], mine: true },
  resolve: { statuses: ['active', 'claim_pending'], mine: true },
  void: { statuses: ['active', 'claim_pending'], mine: true },
  confirm: { statuses: ['claim_pending'], mine: true },
  dispute: { statuses: ['claim_pending'], mine: true },
  info: { mine: false },
};

async function autocomplete(app: App, i: Autocomplete) {
  const focused = i.options.getFocused(true);
  if (focused.name === 'duration') {
    const config = await guildConfig(app, i.guildId);
    const q = focused.value.toLowerCase();
    return i.respond(
      config.allowedDurations
        .filter((d) => d.includes(q))
        .map((d) => ({ name: formatDuration(MUTE_DURATIONS[d]), value: d })),
    );
  }
  const scope = AUTOCOMPLETE_SCOPE[i.options.getSubcommand()] ?? { mine: false };
  const bets = await searchBets(app.db, i.guildId, {
    query: focused.value,
    userIds: memberIdsMatching(i.guild, focused.value),
    partyId: scope.mine ? i.user.id : undefined,
    statuses: scope.statuses,
  });
  await i.respond(bets.map((b) => ({ name: betChoiceLabel(i.guild, b), value: b.shortId })));
}

export const betCommand: CommandModule = { name: 'bet', execute, autocomplete };
