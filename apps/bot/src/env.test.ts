import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.ts';

const valid = {
  DISCORD_TOKEN: 'abc',
  DISCORD_CLIENT_ID: '1557619779026554950',
  DATABASE_URL: 'postgres://u:p@localhost:5437/db',
};

describe('parseEnv', () => {
  it('applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.HEALTH_PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DISCORD_DEV_GUILD_ID).toBeUndefined();
  });

  it('treats an empty dev guild as unset', () => {
    expect(parseEnv({ ...valid, DISCORD_DEV_GUILD_ID: '' }).DISCORD_DEV_GUILD_ID).toBeUndefined();
  });

  it('reports every missing variable without echoing values', () => {
    expect(() => parseEnv({ DISCORD_CLIENT_ID: 'nope' })).toThrow(/DISCORD_TOKEN[\s\S]*DISCORD_CLIENT_ID[\s\S]*DATABASE_URL/);
  });
});
