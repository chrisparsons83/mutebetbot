import { getBet, getClaim } from '@mutebetbot/db';
import { MessageFlags, type ButtonInteraction, type Interaction, type RepliableInteraction } from 'discord.js';
import { betCommand } from './commands/bet.ts';
import type { CommandModule } from './commands/common.ts';
import { muteCommand } from './commands/mute.ts';
import { mutebetCommand } from './commands/mutebet.ts';
import type { App } from './context.ts';
import { renderBetMessage } from './discord/render.ts';
import { onlyUsers, UserError } from './discord/util.ts';
import { acceptBet, cancelBet, declineBet, respondToClaim } from './services/bets.ts';

const COMMANDS = new Map<string, CommandModule>([betCommand, muteCommand, mutebetCommand].map((c) => [c.name, c]));

/** Shows a UserError's message (ephemeral) or a generic line for unexpected errors. */
async function reportError(app: App, i: RepliableInteraction, e: unknown) {
  const expected = e instanceof UserError;
  if (!expected) app.log.error({ err: e, interaction: i.id, user: i.user.id, guild: i.guildId }, 'interaction failed');
  const content = expected ? e.message : 'Something went wrong on my end. Please try again.';
  try {
    // A deferred command shows "thinking…" until edited; buttons deferred with deferUpdate get a follow-up instead.
    if (i.isChatInputCommand() && i.deferred && !i.replied) await i.editReply({ content, allowedMentions: onlyUsers() });
    else if (i.deferred || i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
    else await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: onlyUsers() });
  } catch (err) {
    app.log.debug({ err }, 'could not report error to user');
  }
}

async function onButton(app: App, i: ButtonInteraction) {
  const [scope, action, id] = i.customId.split(':');
  if (!id) return;
  if (scope === 'bet') {
    const bet = await getBet(app.db, id);
    if (!bet) throw new UserError('That bet no longer exists.');
    const updated =
      action === 'accept'
        ? await acceptBet(app, id, i.user.id)
        : action === 'decline'
          ? await declineBet(app, id, i.user.id)
          : await cancelBet(app, bet, i.user.id);
    await i.update({ ...renderBetMessage(updated), allowedMentions: onlyUsers() });
    if (action === 'accept' && updated.status === 'proposed') {
      await i.followUp({ content: 'Accepted. Waiting on the other side.', flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (scope === 'claim') {
    const claim = await getClaim(app.db, id);
    const bet = claim ? await getBet(app.db, claim.betId) : undefined;
    if (!claim || !bet) throw new UserError('That claim no longer exists.');
    await i.deferUpdate();
    const r = await respondToClaim(app, bet, i.user.id, action === 'confirm' ? 'confirm' : 'dispute', undefined, claim.id);
    const msg = { resolved: 'Confirmed. The bet is settled.', disputed: 'Disputed. An admin will rule.', opened: 'Got it. The bet stays on.' }[r.kind];
    await i.followUp({ content: msg });
  }
}

export async function handleInteraction(app: App, i: Interaction): Promise<void> {
  if (i.isAutocomplete()) {
    if (!i.inCachedGuild()) return;
    await COMMANDS.get(i.commandName)
      ?.autocomplete?.(app, i)
      .catch((e: unknown) => app.log.warn({ err: e }, 'autocomplete failed'));
    return;
  }
  if (!i.isRepliable()) return;
  try {
    if (i.isChatInputCommand()) {
      if (!i.inCachedGuild()) throw new UserError('MuteBetBot commands only work inside a server.');
      const command = COMMANDS.get(i.commandName);
      if (!command) throw new UserError('Unknown command. The command list may be updating; try again in a minute.');
      await command.execute(app, i);
    } else if (i.isButton()) {
      await onButton(app, i);
    }
  } catch (e) {
    await reportError(app, i, e);
  }
}
