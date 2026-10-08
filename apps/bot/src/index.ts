import { createDb } from '@mutebetbot/db';
import { SWEEP_INTERVAL_S } from '@mutebetbot/shared';
import { AuditLogEvent, Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import type { App } from './context.ts';
import { parseEnv } from './env.ts';
import { startHealthServer } from './health.ts';
import { handleInteraction } from './interactions.ts';
import { createLogger } from './logger.ts';
import { onBetMessageDeleted } from './services/bets.ts';
import { installGuild, removeGuild, syncGuilds } from './services/guild-setup.ts';
import { finalizeMute, onMemberJoin, onMemberLeave, onMessage, onTimeoutRemoved, reconcileMutes } from './services/mutes.ts';
import { MuteScheduler } from './services/scheduler.ts';
import { runSweep } from './services/sweep.ts';

const env = parseEnv();
const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
const { db, close: closeDb } = createDb(env.DATABASE_URL);

const client = new Client({
  // Message Content is deliberately absent: honor-mute callouts only read author and channel.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration],
  // Uncached proposal messages and departed members still produce delete/remove events.
  partials: [Partials.Message, Partials.GuildMember],
  // Nothing the bot sends can ping anyone unless a call opts specific users in.
  allowedMentions: { parse: [] },
  makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 25 }),
});

// The scheduler needs `app` and `app` needs the scheduler; bind lazily.
const app = { env, log, db, lastCreateAt: new Map(), honorTargets: new Map() } as unknown as App;
app.scheduler = new MuteScheduler(
  async (muteId) => void (await finalizeMute(app, muteId, 'expired')),
  (err, muteId) => log.error({ err, muteId }, 'finalizing mute failed'),
);

const safely =
  <A extends unknown[]>(name: string, fn: (...args: A) => Promise<unknown>) =>
  (...args: A) => {
    fn(...args).catch((err: unknown) => log.error({ err }, `${name} handler failed`));
  };

let sweepTimer: NodeJS.Timeout | undefined;

client.once(
  Events.ClientReady,
  safely('ready', async (ready: Client<true>) => {
    app.client = ready;
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'connected to Discord');
    await syncGuilds(app);
    const reconciled = await reconcileMutes(app);
    log.info(reconciled, 'mute timers rebuilt');
    // Run once now so anything that changed while offline (expired proposals, etc.) is re-rendered.
    await runSweep(app);
    sweepTimer = setInterval(() => void runSweep(app).catch((err: unknown) => log.error({ err }, 'sweep failed')), SWEEP_INTERVAL_S * 1000);
  }),
);

client.on(Events.InteractionCreate, safely('interaction', (i) => handleInteraction(app, i)));
client.on(Events.GuildCreate, safely('guildCreate', (guild) => installGuild(app, guild)));
client.on(
  Events.GuildDelete,
  safely('guildDelete', async (guild) => {
    // An outage makes guilds unavailable without removing us; only act on real removals.
    if (guild.available) await removeGuild(app, guild.id);
  }),
);
client.on(Events.MessageDelete, safely('messageDelete', (message) => onBetMessageDeleted(app, message.id)));
client.on(
  Events.MessageCreate,
  safely('messageCreate', async (message) => {
    if (message.inGuild() && !message.author.bot) await onMessage(app, message);
  }),
);
client.on(Events.GuildMemberRemove, safely('memberRemove', (member) => onMemberLeave(app, member.guild.id, member.id)));
client.on(Events.GuildMemberAdd, safely('memberAdd', (member) => onMemberJoin(app, member)));
client.on(
  Events.GuildAuditLogEntryCreate,
  safely('auditLog', async (entry, guild) => {
    if (entry.action !== AuditLogEvent.MemberUpdate || !entry.targetId) return;
    const lifted = entry.changes.some((c) => c.key === 'communication_disabled_until' && c.old && !c.new);
    if (lifted) await onTimeoutRemoved(app, guild.id, entry.targetId, entry.executorId);
  }),
);
client.on(Events.Error, (err) => log.error({ err }, 'client error'));
client.on(Events.ShardDisconnect, () => log.warn('gateway disconnected'));
client.on(Events.ShardResume, () => log.info('gateway resumed'));

app.client = client as Client<true>;
const health = startHealthServer(app, env.HEALTH_PORT);

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  clearInterval(sweepTimer);
  app.scheduler.stop();
  health.close();
  await client.destroy();
  await closeDb();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await client.login(env.DISCORD_TOKEN);
