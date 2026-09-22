import { EnvValidationError } from '@mutebetbot/shared';
import { describe, expect, it } from 'vitest';
import { loadBotEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DISCORD_TOKEN: 'token',
  DISCORD_CLIENT_ID: '123456789012345678',
};

describe('loadBotEnv', () => {
  it('applies defaults', () => {
    expect(loadBotEnv(valid)).toEqual({
      ...valid,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HEALTH_PORT: 8080,
    });
  });

  it('keeps snowflakes as strings', () => {
    const env = loadBotEnv({ ...valid, DISCORD_DEV_GUILD_ID: '98765432109876543210' });
    expect(env.DISCORD_DEV_GUILD_ID).toBe('98765432109876543210');
    expect(typeof env.DISCORD_CLIENT_ID).toBe('string');
  });

  it('treats an empty dev guild id as unset', () => {
    expect(loadBotEnv({ ...valid, DISCORD_DEV_GUILD_ID: '' }).DISCORD_DEV_GUILD_ID).toBeUndefined();
  });

  it('rejects malformed values', () => {
    expect(() => loadBotEnv({ ...valid, DISCORD_CLIENT_ID: 'abc' })).toThrow(EnvValidationError);
    expect(() => loadBotEnv({ ...valid, HEALTH_PORT: '70000' })).toThrow(EnvValidationError);
    expect(() => loadBotEnv({ ...valid, LOG_LEVEL: 'verbose' })).toThrow(EnvValidationError);
  });

  it('requires the token, client id, and database url', () => {
    try {
      loadBotEnv({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const keys = (e as EnvValidationError).issues.map((i) => i.split(':')[0]);
      expect(keys).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID']),
      );
    }
  });
});
