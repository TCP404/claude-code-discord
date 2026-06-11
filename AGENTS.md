# AGENTS.md

## Project Snapshot

This repository is a Discord bot that exposes Claude Code through Discord slash
commands and session threads. It runs on Deno via `npx deno`; do not assume a
global `deno` binary is installed.

Main runtime entry:

- `index.ts`

Core flow:

```text
Discord slash command
  -> core/handler-registry.ts
  -> claude/client.ts
  -> @anthropic-ai/claude-agent-sdk
  -> claude/discord-sender.ts
  -> claude/sender-renderers.ts
  -> discord/message-sender.ts
```

## Commands

Use these commands from the repository root:

```bash
npx deno task start
npx deno task dev
npx deno task test
npx deno check index.ts
npx deno lint
npx deno fmt
```

The bot is normally managed as a macOS LaunchAgent through `just`:

```bash
just start
just stop
just restart
just status
just logs
```

If the user says the service is already running, inspect it with `just status`
and `just logs` instead of starting another foreground process.

## Before Committing

Before any commit, run:

```bash
npx deno task test
```

Do not commit with failing tests. For type-sensitive changes, also run:

```bash
npx deno check index.ts
```

## Testing Rules

- Tests use `Deno.test` and assertions from
  `https://deno.land/std@0.208.0/assert/mod.ts`.
- Test files are colocated and named `*_test.ts`.
- Add or update tests when fixing bugs, changing signatures, or modifying code
  that already has colocated tests.
- Prefer testing pure functions and state transitions directly. Mock Discord or
  SDK boundaries only when unavoidable.

## Important Directories

- `claude/` - Claude Agent SDK integration, query execution, senders, hot query.
- `core/` - bot setup, handler registry, settings wiring, workspace management.
- `discord/` - Discord.js layer, message sending, session threads, interactions.
- `cron/` - scheduled task store, scheduler, and executor.
- `admin/` - localhost admin UI and HTTP routes.
- `settings/` - unified settings state and command handlers.
- `workspace/` - multi-workspace slash command handlers.

## Code Conventions

- TypeScript strict mode.
- Deno APIs are preferred. Avoid Node APIs unless the existing code requires it.
- Keep imports direct from source files, not barrel `index.ts` re-exports.
- New source files should start with a concise `/** @module ... */` header.
- Avoid new third-party dependencies. The project is intentionally small:
  `discord.js` and `@anthropic-ai/claude-agent-sdk` are the primary runtime
  dependencies.
- Shared types live in layer-local `types.ts` files.
- Keep changes scoped. Do not refactor unrelated modules while fixing a bug.

## Runtime State

Persistent runtime files live under `.bot-data/`:

- `session-threads.json` maps Claude sessions to Discord threads.
- `workspaces.json` maps Discord channels to working directories.
- scheduled task data is managed by `cron/persistence.ts`.

The bot supports multiple workspaces. When handling thread messages, resolve the
working directory from the thread parent channel.

## Session Thread Notes

- Thread auto-resume is routed from `index.ts`.
- Session/thread mapping logic is in `discord/session-threads.ts`.
- Thread creation helpers are in `discord/session-thread-callbacks.ts`.
- Hot query reuse is implemented by `claude/hot-query.ts` and
  `claude/hot-query-registry.ts`.
- `/stop` uses the active SDK query or the hot-query fallback in
  `claude/query-manager.ts`.

When debugging thread resume issues, trace this chain first:

```text
threadId
  -> SessionThreadManager.findSessionByThreadId()
  -> pending/failed/real sessionId check in index.ts
  -> SessionThreadManager.getThread()
  -> hot or cold resume path
```

## Safety

- Never discard user changes in a dirty worktree.
- Do not use destructive git commands unless explicitly requested.
- Do not edit `.env` values or print secrets.
- Prefer `rg` for searching.
- Use `npx deno ...` for Deno commands.
