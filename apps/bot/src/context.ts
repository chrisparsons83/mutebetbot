import type { Db } from '@mutebetbot/db';
import type { Client } from 'discord.js';
import type { Env } from './env.ts';
import type { Logger } from './logger.ts';
import type { MuteScheduler } from './services/scheduler.ts';

/** Everything a handler needs. Built once in index.ts. */
export interface App {
  env: Env;
  log: Logger;
  db: Db;
  client: Client<true>;
  scheduler: MuteScheduler;
  /** In-memory throttle for `/bet create` (per guild:user). */
  lastCreateAt: Map<string, Date>;
  /** Users currently on an honor mute, per guild; avoids a DB hit per message. */
  honorTargets: Map<string, Set<string>>;
}
