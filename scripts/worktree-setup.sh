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
#   3. Run database migrations.
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

# --- 3. Migrations -------------------------------------------------------------
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
