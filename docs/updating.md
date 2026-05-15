# Updating

## Recommended (macOS LaunchAgent)

If you registered the bot as a LaunchAgent (`just install`), use the bundled update flow:

```bash
just update      # git fetch + show incoming commits + warn on .env.example drift + git pull
just restart     # apply the new code
```

`just update` is deliberately interactive and **does not auto-restart**. It will:

1. Refuse to run with uncommitted local changes (commit or stash first).
2. Print incoming commits so you know what you're pulling.
3. Warn if `.env.example` changed — review and add any new variables to your `.env`.
4. Warn if the LaunchAgent plist template changed — run `just reinstall` after the pull in that case.
5. Ask for confirmation, then `git pull --ff-only`.

Substitute `make` for `just` if you don't have `just` installed. Or call the script directly:

```bash
./scripts/update.sh
./scripts/service.sh restart
```

## Manual

If you're running with `start.sh` (or in the foreground):

```bash
git pull origin main
./start.sh restart
```

Or, running directly:

```bash
git pull origin main
npx deno run --allow-all index.ts
```

## Startup Version Check

The bot automatically checks for updates on startup. If a newer version is available on GitHub, it sends an orange embed in your Discord channel:

> **Update Available** Update available! You are X commits behind.

This check is non-blocking and compares your local git commit against the latest commit on `main` via the GitHub API.
