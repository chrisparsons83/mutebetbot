import { eventsFor, getToken, listWonMutes, transitionToken, upsertGuild, toGuildConfig, type TokenRow } from '@mutebetbot/db';
import { hasTestDb, snowflake, useTestDb } from '@mutebetbot/db/test-helpers';
import { describe, expect, it } from 'vitest';
import type { App } from '../context.ts';
import { UserError } from '../discord/util.ts';
import { betChannelId, grantToken, revokeToken, unqueueToken, type GrantInput } from './mutes.ts';

const H = 3600_000;

describe.runIf(hasTestDb)('granted mutes (integration, Discord stubbed)', () => {
  const db = useTestDb();
  const dms: { userId: string; content: string }[] = [];
  let dmsOpen = true;
  // No guilds in the client cache, so bet-card refreshes and announcements are skipped.
  const app = {
    db,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    client: {
      guilds: { cache: new Map() },
      users: {
        fetch: (userId: string) =>
          Promise.resolve({
            send: (p: { content: string }) => {
              if (!dmsOpen) return Promise.reject(Object.assign(new Error('closed'), { code: 50007 }));
              dms.push({ userId, content: p.content });
              return Promise.resolve({ id: snowflake() });
            },
          }),
      },
    },
  } as unknown as App;

  const member = (id = snowflake()) => ({ id, isBot: false, inGuild: true, mutable: true });

  async function input(over: Partial<GrantInput> = {}): Promise<GrantInput> {
    const guildId = snowflake();
    const row = await upsertGuild(db, guildId);
    return { guildId, guildName: 'Test', config: toGuildConfig(row), adminId: snowflake(), holder: member(), target: member(), duration: '30m', ...over };
  }

  it('issues an available token with no bet, logs it, and DMs the holder', async () => {
    const g = await input({ reason: 'Lost the trivia night' });
    const now = new Date();
    const { token, dmSent } = await grantToken(app, g, now);
    expect(token).toMatchObject({ betId: null, grantedBy: g.adminId, holderId: g.holder.id, targetId: g.target.id, durationS: 1800, status: 'available' });
    expect(token.expiresAt!.getTime() - now.getTime()).toBe(30 * 24 * H);
    expect(dmSent).toBe(true);
    const dm = dms.find((d) => d.userId === g.holder.id)!;
    expect(dm.content).toContain(`<@${g.adminId}>`);
    expect(dm.content).toContain(`<@${g.target.id}>`);
    expect(dm.content).toContain('Lost the trivia night');

    const [event] = await eventsFor(db, 'token', token.id);
    expect(event).toMatchObject({ type: 'granted', actorId: g.adminId, payload: { reason: 'Lost the trivia night' } });
    expect(await listWonMutes(db, g.guildId, { holderId: g.holder.id, statuses: ['available'] })).toEqual([{ token, bet: null }]);
    expect(await betChannelId(app, token)).toBeNull();
  });

  it('reports a failed DM instead of throwing', async () => {
    dmsOpen = false;
    try {
      const { dmSent } = await grantToken(app, await input());
      expect(dmSent).toBe(false);
    } finally {
      dmsOpen = true;
    }
  });

  it('refuses invalid grants without issuing anything', async () => {
    const holder = member();
    const g = await input({ holder });
    await expect(grantToken(app, { ...g, target: holder })).rejects.toThrow(/different people/);
    await expect(grantToken(app, { ...g, target: { ...member(), isBot: true } })).rejects.toThrow(UserError);
    await expect(grantToken(app, { ...g, config: { ...g.config, enabled: false } })).rejects.toThrow(/paused/);
    expect(await listWonMutes(db, g.guildId, { statuses: ['available'] })).toEqual([]);
  });

  it('unqueues and revokes like a won mute', async () => {
    const g = await input();
    const { token } = await grantToken(app, g);
    await transitionToken(db, token.id, 'available', 'queued', { queuedAt: new Date() });
    const queued = (await getToken(db, token.id)) as TokenRow;
    await expect(unqueueToken(app, queued, g.target.id)).rejects.toThrow(UserError);
    expect((await unqueueToken(app, queued, g.holder.id)).status).toBe('available');

    await expect(revokeToken(app, token, g.holder.id)).rejects.toThrow(/another admin/);
    expect((await revokeToken(app, token, g.adminId)).status).toBe('revoked');
  });
});
