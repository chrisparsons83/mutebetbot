import { expireTokens, logEvent, purgeRemovedGuilds } from '@mutebetbot/db';
import { GUILD_PURGE_AFTER_S } from '@mutebetbot/shared';
import type { App } from '../context.ts';
import { refreshBetMessage, sweepClaims, sweepProposals } from './bets.ts';

/**
 * Every 5 minutes: windows and expiries that don't need precision. Mutes are not
 * handled here; their ends are driven by per-mute timers.
 */
export async function runSweep(app: App, now = new Date()): Promise<void> {
  const proposals = await sweepProposals(app, now);
  const claims = await sweepClaims(app, now);
  const expired = await expireTokens(app.db, now);
  for (const t of expired) {
    await logEvent(app.db, { guildId: t.guildId, entity: 'token', entityId: t.id, type: 'expired' });
    // Takes the Mute button off the bet card.
    await refreshBetMessage(app, t.betId);
  }
  const purged = await purgeRemovedGuilds(app.db, new Date(now.getTime() - GUILD_PURGE_AFTER_S * 1000));
  if (proposals || claims || expired.length || purged.length) {
    app.log.info({ proposals, claims, tokens: expired.length, purgedGuilds: purged.length }, 'sweep');
  }
}
