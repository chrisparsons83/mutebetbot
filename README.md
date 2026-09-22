# MuteBetBot

A Discord bot where members wager mute time instead of money, plus a small static website.
The spec lives in [`docs/DESIGN.md`](docs/DESIGN.md).

## Layout

| Path              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `apps/bot`        | discord.js v14 bot                                           |
| `apps/web`        | Static website (invite, commands, setup, privacy, terms)     |
| `packages/db`     | Drizzle schema, migrations, query helpers                    |
| `packages/shared` | Pure domain logic, command definitions, durations, env utils |

## Development

Requires Node 22.13+ (24 LTS recommended) and pnpm 10 (`corepack enable`).

```sh
pnpm install
cp .env.example .env   # fill in Discord credentials
pnpm db:up             # Postgres on localhost:5432
pnpm typecheck && pnpm lint && pnpm test
```

Use `/mutebet uninstall` before removing the bot from a server to clean up its role.
