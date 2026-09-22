import { EnvValidationError } from '@mutebetbot/shared';
import { loadBotEnv } from './env.js';

// Phase 1 placeholder: validate configuration and exit.
// The Discord client, scheduler, and /healthz arrive in phase 4.
try {
  const env = loadBotEnv();
  console.log(`MuteBetBot configuration OK (NODE_ENV=${env.NODE_ENV}).`);
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
