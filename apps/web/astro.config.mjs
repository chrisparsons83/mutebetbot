import { existsSync } from 'node:fs';
import { defineConfig } from 'astro/config';

// Local builds read the repo .env; CI and Docker pass these as build args.
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  site: process.env.PUBLIC_BASE_URL ?? 'https://mutebetbot.flexspotff.com',
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'directory' },
});
