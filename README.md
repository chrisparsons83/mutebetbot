# MuteBetBot

A Discord bot where members bet mute time instead of money, plus a small static website. The spec is [docs/DESIGN.md](docs/DESIGN.md).

## Layout

| Path | What |
| --- | --- |
| `apps/bot` | discord.js bot. Pure rules live in `src/domain`; side effects in `src/services` |
| `apps/web` | Astro static site, served by nginx behind Traefik |
| `packages/db` | Drizzle schema, migrations, query helpers |
| `packages/shared` | Command definitions, durations, config defaults, permissions |

TypeScript runs directly on Node 24 (type stripping), so there is no build step for the bot; `tsc` only typechecks.

## Develop

```bash
nvm use                      # Node 24 (.nvmrc)
cp .env.example .env         # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_DEV_GUILD_ID
bash scripts/worktree-setup.sh   # install, start Postgres, create the test DB, migrate
pnpm bot:register            # register slash commands to the dev guild
pnpm bot:dev                 # run the bot with reload
pnpm web:dev                 # run the website
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test` (DB integration tests run when `TEST_DATABASE_URL` is set).

Schema changes: edit `packages/db/src/schema.ts`, then `pnpm db:generate` and `pnpm db:migrate`.

## Deploy

Pushing to `main` runs CI, builds both images, pushes them to the Vultr Container Registry
(`sjc.vultrcr.com/chrisparsons/mutebetbot-{bot,web}`), copies `compose.prod.yaml` to
`~/mutebetbot/compose.yaml` on the VPS, then pulls, restarts, and re-registers global slash commands.

One-time setup:

- Repo secrets (same as flexspotff): `VULTR_USERNAME`, `VULTR_API_KEY`, `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_KEY`.
- Repo variable `DISCORD_CLIENT_ID` for the production app (used to build the `/invite` page).
- On the server, `~/mutebetbot/.env` with `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.

Run only one bot process per token.
