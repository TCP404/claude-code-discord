# claude-code-discord — task runner
#
# Manage the Discord bot as a macOS LaunchAgent.
# All commands are thin wrappers around scripts/*.sh, so you can also run
# the underlying scripts directly without 'just'.
#
# Quick start:
#   cp .env.example .env   # fill in DISCORD_TOKEN + APPLICATION_ID
#   just doctor            # verify your setup
#   just install           # register the service with launchd
#   just start             # start it

set shell := ["bash", "-cu"]

# Default: list available commands.
default:
    @just --list

# Alias for the default listing (matches `make help`).
help:
    @just --list

# One-time setup: copy .env.example if needed, then run doctor.
setup:
    #!/usr/bin/env bash
    set -e
    if [ ! -f .env ]; then
      cp .env.example .env
      echo ".env created from .env.example — open it and fill in your tokens."
      echo ""
    fi
    ./scripts/doctor.sh

# Self-check: tooling, .env, and service state.
doctor:
    @./scripts/doctor.sh

# Register the LaunchAgent (auto-start on login + restart on crash).
install:
    @./scripts/service.sh install

# Remove the LaunchAgent (keeps code, logs, and .env).
uninstall:
    @./scripts/service.sh uninstall

# Re-render the plist and reload (use after pulling plist template changes).
reinstall:
    @./scripts/service.sh reinstall

# Start the service.
start:
    @./scripts/service.sh start

# Stop the service.
stop:
    @./scripts/service.sh stop

# Restart the service.
restart:
    @./scripts/service.sh restart

# Show service status (pid, state, last exit code).
status:
    @./scripts/service.sh status

# Tail launchd stdout + stderr logs.
logs:
    @./scripts/service.sh logs

# Pull latest code. Warns about .env.example drift. Does NOT auto-restart.
update:
    @./scripts/update.sh
