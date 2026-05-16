#!/bin/bash
# Pull the latest code and warn about config drift.
# Does NOT restart the service — user decides when to restart.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d .git ]; then
  echo "ERROR: not a git repository: $SCRIPT_DIR" >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Branch: $BRANCH"

# Refuse to run with uncommitted changes — don't risk clobbering user edits.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo ""
  echo "ERROR: uncommitted changes present. Commit or stash before updating." >&2
  echo "       (run 'git status' to see what's modified)" >&2
  exit 1
fi

echo "Fetching..."
git fetch --quiet

UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -z "$UPSTREAM" ]; then
  echo "ERROR: branch '$BRANCH' has no upstream. Set one with: git branch --set-upstream-to=origin/$BRANCH" >&2
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "$UPSTREAM")

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date."
  exit 0
fi

echo ""
echo "Incoming commits:"
git --no-pager log --oneline "$LOCAL..$REMOTE"
echo ""

# Warn if .env.example is going to change — likely new vars to fill in.
if git diff --name-only "$LOCAL" "$REMOTE" | grep -qx '.env.example'; then
  echo "NOTE: .env.example changes in this update. Diff:"
  echo "---"
  git --no-pager diff "$LOCAL" "$REMOTE" -- .env.example | sed 's/^/  /'
  echo "---"
  echo "Review your local .env after update to add any new required variables."
  echo ""
fi

# Warn if the plist template changed — user needs 'just reinstall'.
if git diff --name-only "$LOCAL" "$REMOTE" | grep -q 'scripts/.*\.plist\.tpl$'; then
  echo "NOTE: LaunchAgent plist template changed. Run 'just reinstall' after update."
  echo ""
fi

read -r -p "Pull these changes? [y/N] " REPLY
case "$REPLY" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

if ! git pull --ff-only; then
  echo ""
  echo "ERROR: fast-forward merge failed (history has diverged)." >&2
  echo "Try: git pull --rebase   (or resolve manually)" >&2
  exit 1
fi
echo ""
echo "Update complete. Service was NOT restarted."
echo "Run 'just restart' (or './scripts/service.sh restart') to apply changes."
