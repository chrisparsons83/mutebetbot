import { dbEnvSchema } from '@mutebetbot/db';
import { parseEnv, type EnvSource } from '@mutebetbot/shared';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake (17–20 digits)');

export const botEnvSchema = dbEnvSchema.extend({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: snowflake,
  /** When set, slash commands are registered to this guild only (instant updates for dev). */
  DISCORD_DEV_GUILD_ID: snowflake.optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
});

export type BotEnv = z.output<typeof botEnvSchema>;

export function loadBotEnv(source?: EnvSource): BotEnv {
  return parseEnv(botEnvSchema, source);
}
