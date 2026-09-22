import { EnvValidationError } from '@mutebetbot/shared';
import { describe, expect, it } from 'vitest';
import { loadDbEnv } from './env.js';

describe('loadDbEnv', () => {
  it('accepts postgres:// and postgresql:// URLs', () => {
    expect(loadDbEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' }).DATABASE_URL).toBe(
      'postgres://u:p@localhost:5432/db',
    );
    expect(() => loadDbEnv({ DATABASE_URL: 'postgresql://localhost/db' })).not.toThrow();
  });

  it('rejects a missing or non-postgres URL', () => {
    expect(() => loadDbEnv({})).toThrow(EnvValidationError);
    expect(() => loadDbEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(EnvValidationError);
  });
});
