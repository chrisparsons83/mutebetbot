import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_DEV_GUILD_ID: z.preprocess(emptyToUndefined, snowflake.optional()),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }
  return result.data;
}
