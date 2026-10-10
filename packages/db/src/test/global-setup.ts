import { runMigrations } from '../migrate.ts';

/** Migrates the integration-test database once per run. Without TEST_DATABASE_URL, DB tests skip. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) await runMigrations(url);
}
