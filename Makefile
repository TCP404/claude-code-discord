# claude-code-discord — task runner (Makefile fallback)
#
# Mirrors Justfile. Use this if you don't have 'just' installed.
# All commands are thin wrappers around scripts/*.sh.
#
# Quick start:
#   cp .env.example .env   # fill in DISCORD_TOKEN + APPLICATION_ID
#   make doctor
#   make install
#   make start

.PHONY: help setup doctor install uninstall reinstall start stop restart status logs update

help:
	@echo "Available targets:"
	@echo "  setup       Copy .env.example to .env (if missing) and run doctor"
	@echo "  doctor      Self-check: tooling, .env, service state"
	@echo "  install     Register the LaunchAgent (auto-start + restart on crash)"
	@echo "  uninstall   Remove the LaunchAgent (keeps code/logs/.env)"
	@echo "  reinstall   Re-render plist and reload (after plist template changes)"
	@echo "  start       Start the service"
	@echo "  stop        Stop the service"
	@echo "  restart     Restart the service"
	@echo "  status      Show service status"
	@echo "  logs        Tail launchd logs"
	@echo "  update      Pull latest code (does NOT auto-restart)"

setup:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo ".env created from .env.example — open it and fill in your tokens."; \
		echo ""; \
	fi
	@./scripts/doctor.sh

doctor:
	@./scripts/doctor.sh

install:
	@./scripts/service.sh install

uninstall:
	@./scripts/service.sh uninstall

reinstall:
	@./scripts/service.sh reinstall

start:
	@./scripts/service.sh start

stop:
	@./scripts/service.sh stop

restart:
	@./scripts/service.sh restart

status:
	@./scripts/service.sh status

logs:
	@./scripts/service.sh logs

update:
	@./scripts/update.sh
