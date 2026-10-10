#!/usr/bin/env bash
# Prepares a fresh git worktree for development. Orca runs this via orca.yaml
# (scripts.setup) and provides ORCA_ROOT_PATH / ORCA_WORKTREE_PATH /
# ORCA_WORKSPACE_NAME. It can also be run by hand from inside any worktree.
#
# All worktrees share the primary checkout's .env and dev database; only one
# worktree is expected to run the dev bot at a time.
#
# Steps (each is skipped if its prerequisites don't exist yet):
#   1. Ensure .env exists (copy from the primary checkout, else .env.example).
#   2. pnpm install.
#   3. Start the shared dev Postgres (docker compose) and ensure the test database exists.
#   4. Run database migrations.
#
# Safe to re-run.
set -euo pipefail

WORKTREE="${ORCA_WORKTREE_PATH:-$(git rev-parse --show-toplevel)}"
ROOT="${ORCA_ROOT_PATH:-$(dirname "$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir)")}"
NAME="${ORCA_WORKSPACE_NAME:-$(basename "$WORKTREE")}"
cd "$WORKTREE"

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*" >&2; }

# --- 1. .env -----------------------------------------------------------------
if [[ ! -f .env ]]; then
  if [[ -f "$ROOT/.env" && "$ROOT" != "$WORKTREE" ]]; then
    cp "$ROOT/.env" .env
    log "Copied .env from primary checkout"
  elif [[ -f .env.example ]]; then
    cp .env.example .env
    warn "Created .env from .env.example; fill in secrets (e.g. DISCORD_TOKEN) before running the bot"
  else
    warn "No .env or .env.example found; skipping env setup"
  fi
fi

# --- Node version from .nvmrc (when nvm is installed) ------------------------------
if [[ -f .nvmrc && -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  set +u
  # shellcheck disable=SC1091
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null
  nvm install >/dev/null && nvm use >/dev/null && log "Using Node $(node -v)"
  set -u
fi

# --- 2. Dependencies -----------------------------------------------------------
if [[ -f package.json ]]; then
  if ! command -v pnpm >/dev/null; then
    log "pnpm not found; enabling via corepack"
    corepack enable pnpm
  fi
  if [[ -f pnpm-lock.yaml ]]; then
    pnpm install --frozen-lockfile
  else
    pnpm install
  fi
else
  log "No package.json yet; skipping install"
fi

# --- 3. Postgres ---------------------------------------------------------------
if [[ -f compose.yaml ]] && command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  if docker compose up -d --wait postgres >/dev/null 2>&1; then
    log "Postgres is up"
    docker compose exec -T postgres sh -c \
      'psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '"'"'${POSTGRES_DB}_test'"'"'" | grep -q 1 \
        || createdb -U "$POSTGRES_USER" "${POSTGRES_DB}_test"' \
      && log "Test database ready" || warn "Could not create the test database"
  else
    warn "Could not start Postgres; run 'pnpm db:up' later"
  fi
else
  log "Docker not available; skipping Postgres"
fi

# --- 4. Migrations -------------------------------------------------------------
has_script() { [[ -f package.json ]] && node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)"; }
if has_script db:migrate; then
  if pnpm run db:migrate; then
    log "Migrations applied"
  else
    warn "Migrations failed (is Postgres running?); run 'pnpm db:migrate' later"
  fi
else
  log "No db:migrate script yet; skipping migrations"
fi

log "Worktree '$NAME' ready"
