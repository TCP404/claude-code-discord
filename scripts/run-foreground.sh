#!/bin/bash
# Foreground entrypoint for launchd. Unlike start.sh, this does NOT daemonize —
# launchd needs the process to stay in the foreground so it can supervise it.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# Load .env (Deno doesn't auto-load it)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

exec npx --yes deno run --allow-all index.ts
