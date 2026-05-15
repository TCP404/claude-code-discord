#!/bin/bash
# Manage the bot as a macOS LaunchAgent.
#
# Subcommands: install | uninstall | reinstall | start | stop | restart | status | logs
#
# Standalone usage (no Justfile/Makefile required):
#   ./scripts/service.sh install
#   ./scripts/service.sh status

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$SCRIPT_DIR/scripts"
TEMPLATE="$SERVICE_DIR/com.github.imAkaka.claude-code-discord.plist.tpl"

# Allow override via .env (SERVICE_LABEL=...), otherwise use default.
LABEL="${SERVICE_LABEL:-com.github.imAkaka.claude-code-discord}"
if [ -f "$SCRIPT_DIR/.env" ]; then
  ENV_LABEL=$(grep -E '^SERVICE_LABEL=' "$SCRIPT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -n "$ENV_LABEL" ]; then
    LABEL="$ENV_LABEL"
  fi
fi

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$DOMAIN/$LABEL"

ensure_logs_dir() {
  mkdir -p "$SCRIPT_DIR/logs"
}

render_plist() {
  if [ ! -f "$TEMPLATE" ]; then
    echo "ERROR: template not found: $TEMPLATE" >&2
    exit 1
  fi
  mkdir -p "$PLIST_DIR"
  # Inherit current PATH so launchd can find npx/node (especially under nvm).
  sed \
    -e "s|{{LABEL}}|$LABEL|g" \
    -e "s|{{WORKDIR}}|$SCRIPT_DIR|g" \
    -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{PATH}}|$PATH|g" \
    "$TEMPLATE" > "$PLIST_PATH"
  echo "Rendered: $PLIST_PATH"
}

is_loaded() {
  launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

cmd_install() {
  ensure_logs_dir
  render_plist
  if is_loaded; then
    echo "Service already loaded, replacing..."
    launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true
  fi
  launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  launchctl enable "$SERVICE_TARGET"
  echo "Installed: $LABEL (auto-starts on login + restarts on crash)"
  echo "Run 'just start' (or '$0 start') to start now."
}

cmd_uninstall() {
  if is_loaded; then
    launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true
    echo "Bootout: $SERVICE_TARGET"
  fi
  if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH"
    echo "Removed: $PLIST_PATH"
  fi
  echo "Uninstalled. Code, logs, and .env are kept."
}

cmd_start() {
  if ! is_loaded; then
    echo "Service not installed. Run 'install' first." >&2
    exit 1
  fi
  launchctl kickstart "$SERVICE_TARGET"
  echo "Started: $LABEL"
}

cmd_stop() {
  if ! is_loaded; then
    echo "Service not installed."
    return 0
  fi
  launchctl kill SIGTERM "$SERVICE_TARGET" 2>/dev/null || true
  echo "Stop signal sent: $LABEL"
}

cmd_restart() {
  if ! is_loaded; then
    echo "Service not installed. Run 'install' first." >&2
    exit 1
  fi
  launchctl kickstart -k "$SERVICE_TARGET"
  echo "Restarted: $LABEL"
}

cmd_status() {
  if ! is_loaded; then
    echo "Status: not installed"
    return 0
  fi
  echo "Label:   $LABEL"
  echo "Plist:   $PLIST_PATH"
  echo "---"
  launchctl print "$SERVICE_TARGET" | grep -E '^\s*(state|pid|last exit code|program|working directory)\s*=' || true
}

cmd_logs() {
  ensure_logs_dir
  echo "Tailing logs (Ctrl+C to stop)..."
  echo "Files: logs/launchd.out.log, logs/launchd.err.log"
  echo "---"
  tail -F "$SCRIPT_DIR/logs/launchd.out.log" "$SCRIPT_DIR/logs/launchd.err.log"
}

cmd_reinstall() {
  cmd_uninstall
  cmd_install
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  reinstall) cmd_reinstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *)
    echo "Usage: $0 {install|uninstall|reinstall|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
