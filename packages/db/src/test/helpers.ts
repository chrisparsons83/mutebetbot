import { randomInt } from 'node:crypto';
import { afterAll } from 'vitest';
import { createDb, type Db } from '../client.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

/** A pool for one test file, closed after it. Only call inside `describe.runIf(hasTestDb)`. */
export function useTestDb(): Db {
  const handle = createDb(TEST_DATABASE_URL!, { max: 5 });
  afterAll(() => handle.close());
  return handle.db;
}

/** A random snowflake, so test files never collide and need no truncation. */
export function snowflake(): string {
  return `${randomInt(1, 2 ** 47)}${randomInt(10_000, 99_999)}`;
}
