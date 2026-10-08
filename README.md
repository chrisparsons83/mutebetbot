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

`docker compose -f compose.prod.yaml up -d --build` runs Postgres, a one-shot migration, the bot, and the website (Traefik routes `mutebetbot.flexspotff.com`). Run `pnpm bot:register --global` once with production credentials to register commands globally. Run only one bot process per token.
