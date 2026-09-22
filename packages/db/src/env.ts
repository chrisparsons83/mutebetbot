import { parseEnv, type EnvSource } from '@mutebetbot/shared';
import { z } from 'zod';

export const dbEnvSchema = z.object({
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .describe('Postgres connection string, e.g. postgres://user:pass@host:5432/db'),
});

export type DbEnv = z.output<typeof dbEnvSchema>;

export function loadDbEnv(source?: EnvSource): DbEnv {
  return parseEnv(dbEnvSchema, source);
}
