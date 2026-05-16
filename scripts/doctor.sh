#!/bin/bash
# Self-check for common setup issues. Read-only — never modifies state.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

LABEL="${SERVICE_LABEL:-com.github.imAkaka.claude-code-discord}"
if [ -f .env ]; then
  ENV_LABEL=$(grep -E '^SERVICE_LABEL=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  [ -n "$ENV_LABEL" ] && LABEL="$ENV_LABEL"
fi
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE_TARGET="gui/$(id -u)/$LABEL"

PASS=0
WARN=0
FAIL=0

ok()    { printf "  \033[32mOK\033[0m    %s\n" "$1"; PASS=$((PASS+1)); }
warn()  { printf "  \033[33mWARN\033[0m  %s\n" "$1"; WARN=$((WARN+1)); }
fail()  { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAIL=$((FAIL+1)); }
note()  { printf "        %s\n" "$1"; }

echo "Tooling"
if command -v node >/dev/null 2>&1; then
  ok "node found ($(node --version))"
else
  fail "node not found — install Node.js first"
fi
if command -v npx >/dev/null 2>&1; then
  ok "npx found"
else
  fail "npx not found"
fi
if command -v git >/dev/null 2>&1; then
  ok "git found"
else
  fail "git not found"
fi
DENO_VER=$(npx --yes deno --version 2>/dev/null | head -1)
if [ -n "$DENO_VER" ]; then
  ok "deno available via npx ($DENO_VER)"
else
  fail "npx deno not working — bot cannot start"
fi

echo ""
echo "Project files"
if [ -f index.ts ]; then
  ok "index.ts present"
else
  fail "index.ts missing — wrong directory?"
fi
if [ -f deno.json ]; then
  ok "deno.json present"
else
  fail "deno.json missing"
fi
if [ -d logs ] && [ -w logs ]; then
  ok "logs/ writable"
else
  warn "logs/ missing or not writable (will be created on first run)"
fi

echo ""
echo "Configuration"
if [ -f .env ]; then
  ok ".env present"
  if grep -qE '^DISCORD_TOKEN=.+' .env && ! grep -qE '^DISCORD_TOKEN=$|^DISCORD_TOKEN=your' .env; then
    ok "DISCORD_TOKEN looks set"
  else
    fail "DISCORD_TOKEN missing or unfilled in .env"
  fi
  if grep -qE '^APPLICATION_ID=.+' .env && ! grep -qE '^APPLICATION_ID=$|^APPLICATION_ID=your' .env; then
    ok "APPLICATION_ID looks set"
  else
    fail "APPLICATION_ID missing or unfilled in .env"
  fi
  if grep -qE '^CLAUDE_CODE_USE_BEDROCK=1' .env; then
    note "Auth mode: AWS Bedrock"
  elif grep -qE '^ANTHROPIC_API_KEY=.+' .env && ! grep -qE '^ANTHROPIC_API_KEY=$|^ANTHROPIC_API_KEY=your' .env; then
    note "Auth mode: Anthropic API key"
  else
    warn "Neither CLAUDE_CODE_USE_BEDROCK=1 nor ANTHROPIC_API_KEY=... detected"
  fi
else
  fail ".env missing — copy .env.example and fill in tokens"
fi

echo ""
echo "LaunchAgent"
if [ -f "$PLIST_PATH" ]; then
  ok "plist installed ($PLIST_PATH)"
else
  warn "plist not installed — run 'just install' to register as LaunchAgent"
fi
if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  ok "service loaded into launchd ($LABEL)"
  STATE=$(launchctl print "$SERVICE_TARGET" 2>/dev/null | awk -F'= ' '/^\s*state\s*=/ {print $2; exit}')
  PID=$(launchctl print "$SERVICE_TARGET" 2>/dev/null | awk -F'= ' '/^\s*pid\s*=/ {print $2; exit}')
  if [ -n "$PID" ]; then
    note "running, pid $PID"
  else
    note "loaded but not currently running (state: ${STATE:-unknown})"
  fi
else
  warn "service not loaded — run 'just start' (after 'just install')"
fi

echo ""
echo "Summary: $PASS ok, $WARN warn, $FAIL fail"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
