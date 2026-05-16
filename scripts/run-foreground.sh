#!/bin/bash
# Foreground entrypoint for launchd. Unlike start.sh, this does NOT daemonize —
# launchd needs the process to stay in the foreground so it can supervise it.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/logs/app.pid"

# Prevent multiple instances — refuse if another bot process is alive.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "ERROR: bot already running (PID $(cat "$PID_FILE")). Stop it first." >&2
  exit 1
fi

mkdir -p "$SCRIPT_DIR/logs"
echo $$ > "$PID_FILE"

# Load .env (Deno doesn't auto-load it)
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '#'*|'') continue ;;
    esac
    export "$line"
  done < .env
fi

exec npx --yes deno run --allow-all index.ts
