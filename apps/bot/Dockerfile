# Build from the repo root: docker build -f apps/bot/Dockerfile .
# The same image runs the bot and, with a different command, the migrations.
FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot/package.json apps/bot/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter "@mutebetbot/bot..."
COPY packages packages
COPY apps/bot apps/bot
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Node 24 runs the TypeScript source directly (type stripping); there is no build step.
CMD ["node", "apps/bot/src/index.ts"]
