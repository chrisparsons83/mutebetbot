import {
  ApplicationCommandOptionType as Opt,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  type APIApplicationCommandBasicOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord-api-types/v10';
import { CONFIG_LIMITS, TERMS_MAX_LENGTH } from './config.ts';
import { TOKEN_EXPIRY_KEYS } from './durations.ts';

/**
 * Every slash command, as the JSON Discord expects. The bot registers these and the
 * website's /commands page is generated from them, so this is the single source of truth.
 * `who` is website-only metadata and is stripped before registration.
 */
export interface CommandDoc {
  /** Who may use each subcommand, keyed by its path ("create", "config set"). */
  who: Record<string, string>;
}

type Command = RESTPostAPIChatInputApplicationCommandsJSONBody & { doc: CommandDoc };

const guildOnly: Pick<RESTPostAPIChatInputApplicationCommandsJSONBody, 'type' | 'contexts' | 'integration_types'> = {
  type: ApplicationCommandType.ChatInput,
  contexts: [InteractionContextType.Guild],
  integration_types: [ApplicationIntegrationType.GuildInstall],
};

/** Pick a bet from autocomplete (search by name or terms). The value sent is the bet's internal short ID. */
const betOption = (description = 'Pick a bet'): APIApplicationCommandBasicOption => ({
  type: Opt.String,
  name: 'bet',
  description,
  required: true,
  autocomplete: true,
  max_length: 100,
});

export const BET_COMMAND: Command = {
  ...guildOnly,
  name: 'bet',
  description: 'Wager mute time against another member',
  options: [
    {
      type: Opt.Subcommand,
      name: 'create',
      description: 'Propose a bet. Both of you must click Accept for it to count.',
      options: [
        { type: Opt.User, name: 'opponent', description: 'Who you are betting against', required: true },
        {
          type: Opt.String,
          name: 'prediction',
          description: 'What you think will happen, e.g. Oklahoma scores over 30.5 against Texas',
          required: true,
          max_length: TERMS_MAX_LENGTH,
        },
        {
          type: Opt.String,
          name: 'duration',
          description: 'How long the loser is muted',
          required: true,
          autocomplete: true,
        },
      ],
    },
    { type: Opt.Subcommand, name: 'cancel', description: 'Cancel your proposal before it is accepted', options: [betOption()] },
    {
      type: Opt.Subcommand,
      name: 'resolve',
      description: 'Claim the result; the other party confirms or disputes',
      options: [
        betOption(),
        {
          type: Opt.String,
          name: 'outcome',
          description: 'Who won?',
          required: true,
          choices: [
            { name: 'I won', value: 'win' },
            { name: 'They won', value: 'lose' },
          ],
        },
      ],
    },
    { type: Opt.Subcommand, name: 'void', description: 'Propose calling the bet off (no-contest)', options: [betOption()] },
    { type: Opt.Subcommand, name: 'confirm', description: 'Agree to the pending claim or void', options: [betOption()] },
    {
      type: Opt.Subcommand,
      name: 'dispute',
      description: 'Dispute the pending claim; an admin will rule',
      options: [betOption(), { type: Opt.String, name: 'reason', description: 'Why you disagree', max_length: 200 }],
    },
    {
      type: Opt.Subcommand,
      name: 'list',
      description: 'List bets in this server',
      options: [
        { type: Opt.User, name: 'user', description: 'Only bets involving this member' },
        {
          type: Opt.String,
          name: 'status',
          description: 'Only bets in this state',
          choices: [
            { name: 'Open (proposed, active, pending, disputed)', value: 'open' },
            { name: 'Proposed', value: 'proposed' },
            { name: 'Active', value: 'active' },
            { name: 'Claim pending', value: 'claim_pending' },
            { name: 'Disputed', value: 'disputed' },
            { name: 'Resolved', value: 'resolved' },
            { name: 'Void', value: 'void' },
            { name: 'Closed without result (declined, expired, cancelled)', value: 'closed' },
          ],
        },
        { type: Opt.Integer, name: 'page', description: 'Page number', min_value: 1 },
      ],
    },
    { type: Opt.Subcommand, name: 'info', description: 'Full history of a bet', options: [betOption()] },
  ],
  doc: {
    who: {
      create: 'Anyone',
      cancel: 'Challenger',
      resolve: 'Either party',
      void: 'Either party',
      confirm: 'The non-claiming party',
      dispute: 'The non-claiming party',
      list: 'Anyone',
      info: 'Anyone',
    },
  },
};

export const MUTE_COMMAND: Command = {
  ...guildOnly,
  name: 'mute',
  description: 'Use the mutes you have won',
  options: [
    { type: Opt.Subcommand, name: 'list', description: "Mutes you've won and haven't used yet" },
    {
      type: Opt.Subcommand,
      name: 'use',
      description: 'Mute the loser now',
      options: [
        betOption('The bet you won'),
        {
          type: Opt.Boolean,
          name: 'queue',
          description: 'If the server is at its mute cap, wait in line instead of failing',
        },
      ],
    },
    { type: Opt.Subcommand, name: 'unqueue', description: 'Take a waiting mute out of line', options: [betOption('The bet you won')] },
    { type: Opt.Subcommand, name: 'status', description: 'Who is bet-muted right now, and who is waiting' },
  ],
  doc: { who: { list: 'Anyone', use: 'The winner', unqueue: 'The winner', status: 'Anyone' } },
};

export const MUTEBET_COMMAND: Command = {
  ...guildOnly,
  name: 'mutebet',
  description: 'Server admin tools for MuteBetBot',
  options: [
    {
      type: Opt.Subcommand,
      name: 'rule',
      description: 'Resolve or void any active or disputed bet',
      options: [
        betOption(),
        { type: Opt.User, name: 'winner', description: 'The winner (omit when voiding)' },
        { type: Opt.Boolean, name: 'void', description: 'Void the bet instead of picking a winner' },
      ],
    },
    {
      type: Opt.Subcommand,
      name: 'unmute',
      description: 'End a bet-mute early',
      options: [{ type: Opt.User, name: 'user', description: 'The bet-muted member', required: true }],
    },
    {
      type: Opt.Subcommand,
      name: 'grant',
      description: 'Give a member a mute without a bet. It works like one won on a bet.',
      options: [
        { type: Opt.User, name: 'holder', description: 'Who gets the mute', required: true },
        { type: Opt.User, name: 'target', description: 'Who the mute can be used on', required: true },
        { type: Opt.String, name: 'duration', description: 'How long the mute lasts', required: true, autocomplete: true },
        { type: Opt.String, name: 'reason', description: 'Sent to the holder and kept in the history', max_length: 200 },
      ],
    },
    { type: Opt.Subcommand, name: 'revoke', description: "Cancel a mute that hasn't been used", options: [betOption('The mute to cancel')] },
    {
      type: Opt.SubcommandGroup,
      name: 'config',
      description: 'Server settings',
      options: [
        { type: Opt.Subcommand, name: 'view', description: 'Show current settings' },
        {
          type: Opt.Subcommand,
          name: 'set',
          description: 'Change settings (bets already made keep their settings)',
          options: [
            {
              type: Opt.Integer,
              name: 'max_concurrent_mutes',
              description: 'Cap on simultaneous bet-mutes',
              min_value: CONFIG_LIMITS.maxConcurrentMutes.min,
              max_value: CONFIG_LIMITS.maxConcurrentMutes.max,
            },
            {
              type: Opt.String,
              name: 'mute_expiry',
              description: 'How long a winner has to use their mute',
              choices: TOKEN_EXPIRY_KEYS.map((k) => ({ name: k, value: k })),
            },
            {
              type: Opt.String,
              name: 'allowed_durations',
              description: 'Comma-separated subset of 30m, 1h, 2h, 6h, 24h',
              max_length: 40,
            },
            { type: Opt.String, name: 'confirm_window', description: 'Time to answer a claim, 1h to 14d (e.g. 72h)', max_length: 16 },
            { type: Opt.String, name: 'target_cooldown', description: 'Gap between mutes on one member, 0 to 7d (e.g. 24h)', max_length: 16 },
            {
              type: Opt.Integer,
              name: 'max_open_proposals_per_user',
              description: 'Proposed bets one member can have open',
              min_value: CONFIG_LIMITS.maxOpenProposalsPerUser.min,
              max_value: CONFIG_LIMITS.maxOpenProposalsPerUser.max,
            },
            {
              type: Opt.String,
              name: 'unmutable_members',
              description: 'Bets involving admins or members above the bot',
              choices: [
                { name: 'honor: allow, with an honor mute', value: 'honor' },
                { name: 'reject: refuse those bets', value: 'reject' },
              ],
            },
            {
              type: Opt.String,
              name: 'rejoin_policy',
              description: 'When a muted member leaves and rejoins',
              choices: [
                { name: 'restart_full: full duration again', value: 'restart_full' },
                { name: 'resume_remaining: only what was left', value: 'resume_remaining' },
              ],
            },
            { type: Opt.Role, name: 'admin_role', description: 'Role that may use admin commands' },
            { type: Opt.Boolean, name: 'clear_admin_role', description: 'Remove the admin role setting' },
            {
              type: Opt.Channel,
              name: 'announce_channel',
              description: 'Where resolutions, disputes, and mutes are posted',
              channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
            },
            { type: Opt.Boolean, name: 'clear_announce_channel', description: 'Post in the channel where things happen' },
            { type: Opt.Boolean, name: 'enabled', description: 'Allow new bets and mutes' },
          ],
        },
      ],
    },
    { type: Opt.Subcommand, name: 'repair', description: 'Recreate the marker role and check permissions and role order' },
    {
      type: Opt.Subcommand,
      name: 'uninstall',
      description: 'Lift bet-mutes, delete the marker role, and leave the server',
      options: [{ type: Opt.Boolean, name: 'confirm', description: 'Set to true to really uninstall', required: true }],
    },
  ],
  doc: {
    who: {
      rule: 'Admin',
      unmute: 'Admin',
      grant: 'Admin',
      revoke: 'Admin',
      'config view': 'Admin',
      'config set': 'Admin',
      repair: 'Admin',
      uninstall: 'Admin',
    },
  },
};

export const COMMANDS: readonly Command[] = [BET_COMMAND, MUTE_COMMAND, MUTEBET_COMMAND];

/** The registration payload (website metadata stripped). */
export function commandPayloads(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return COMMANDS.map(({ doc: _doc, ...body }) => body);
}
