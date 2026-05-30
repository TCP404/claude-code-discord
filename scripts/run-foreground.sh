#!/bin/bash
# Foreground entrypoint for launchd. Unlike start.sh, this does NOT daemonize —
# launchd needs the process to stay in the foreground so it can supervise it.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/logs/app.pid"

# Prevent multiple instances — refuse if another bot process is alive.
# We also verify the process command looks like our bot, because PIDs get
# recycled by the OS and a stale pid file can otherwise match an unrelated
# process (e.g. Chrome Helper) and wedge launchd in a restart loop.
if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE")"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    EXISTING_CMD="$(ps -p "$EXISTING_PID" -o command= 2>/dev/null || true)"
    case "$EXISTING_CMD" in
      *deno*|*run-foreground.sh*)
        echo "ERROR: bot already running (PID $EXISTING_PID). Stop it first." >&2
        exit 1
        ;;
      *)
        echo "WARN: stale pid file (PID $EXISTING_PID belongs to '$EXISTING_CMD'), removing." >&2
        rm -f "$PID_FILE"
        ;;
    esac
  else
    rm -f "$PID_FILE"
  fi
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
