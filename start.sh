#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$LOG_DIR/app.pid"

mkdir -p "$LOG_DIR"

do_start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Already running (PID $(cat "$PID_FILE")). Use '$0 restart' to restart."
    return 1
  fi

  LOG_FILE="$LOG_DIR/app-$(date +%Y%m%d-%H%M%S).log"
  cd "$SCRIPT_DIR"

  # Load .env file into environment (Deno doesn't auto-load .env)
  if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        '#'*|'') continue ;;
      esac
      export "$line"
    done < .env
    echo "Loaded .env file"
    echo "ALLOW_ANY_CHANNEL=$ALLOW_ANY_CHANNEL"
  fi

  nohup npx --yes deno run --allow-all index.ts > "$LOG_FILE" 2>&1 &

  PID=$!
  echo "$PID" > "$PID_FILE"
  echo "Started with PID $PID, log: $LOG_FILE"
}

do_stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "PID file not found, nothing to stop."
    return 1
  fi

  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    # Kill child processes then the main process
    pkill -P "$PID" 2>/dev/null
    kill "$PID" 2>/dev/null
    # Wait up to 5 seconds for graceful shutdown
    for i in $(seq 1 10); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still alive
    if kill -0 "$PID" 2>/dev/null; then
      pkill -9 -P "$PID" 2>/dev/null
      kill -9 "$PID" 2>/dev/null
      echo "Force killed PID $PID"
    else
      echo "Stopped PID $PID"
    fi
  else
    echo "Process $PID not running."
  fi
  rm -f "$PID_FILE"
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  *)       echo "Usage: $0 {start|stop|restart}" ;;
esac
