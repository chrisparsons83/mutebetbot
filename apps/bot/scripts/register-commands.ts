/**
 * Registers slash commands. With DISCORD_DEV_GUILD_ID set, registers to that one
 * server (updates instantly); otherwise registers globally (can take up to an hour).
 *   pnpm bot:register            # uses .env
 *   pnpm bot:register --global   # ignore DISCORD_DEV_GUILD_ID
 *   pnpm bot:register --clear    # remove commands from the target scope
 */
import { REST, Routes } from 'discord.js';
import { commandPayloads } from '@mutebetbot/shared';
import { parseEnv } from '../src/env.ts';

const env = parseEnv();
const global = process.argv.includes('--global') || !env.DISCORD_DEV_GUILD_ID;
const clear = process.argv.includes('--clear');
const rest = new REST().setToken(env.DISCORD_TOKEN);
const route = global
  ? Routes.applicationCommands(env.DISCORD_CLIENT_ID)
  : Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_DEV_GUILD_ID!);

const body = clear ? [] : commandPayloads();
const result = (await rest.put(route, { body })) as unknown[];
const scope = global ? 'globally' : `to guild ${env.DISCORD_DEV_GUILD_ID}`;
console.log(clear ? `Cleared commands ${scope}` : `Registered ${result.length} commands ${scope}`);
