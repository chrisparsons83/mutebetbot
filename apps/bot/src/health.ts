import { createServer, type Server } from 'node:http';
import { pingDb } from '@mutebetbot/db';
import { Status } from 'discord.js';
import type { App } from './context.ts';

/** `GET /healthz`: 200 when the gateway is ready and the database answers, else 503. */
export function startHealthServer(app: Pick<App, 'db' | 'client' | 'log' | 'scheduler'>, port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      const gateway = app.client.ws.status === Status.Ready;
      const db = await pingDb(app.db);
      const body = { ok: gateway && db, gateway, db, guilds: app.client.guilds.cache.size, timers: app.scheduler.size };
      res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    })();
  });
  server.listen(port, () => app.log.info({ port }, 'health server listening'));
  return server;
}
