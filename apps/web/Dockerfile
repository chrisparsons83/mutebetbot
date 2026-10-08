# Build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg DISCORD_CLIENT_ID=... --build-arg PUBLIC_BASE_URL=... .
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@mutebetbot/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG DISCORD_CLIENT_ID
ARG PUBLIC_BASE_URL=https://mutebetbot.flexspotff.com
ENV DISCORD_CLIENT_ID=$DISCORD_CLIENT_ID PUBLIC_BASE_URL=$PUBLIC_BASE_URL
RUN pnpm --filter @mutebetbot/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
