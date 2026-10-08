import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Local runs pick up TEST_DATABASE_URL from .env; CI sets it directly.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['apps/bot/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['packages/db/src/test/global-setup.ts'],
  },
});
