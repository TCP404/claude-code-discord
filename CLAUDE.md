# CLAUDE.md

## Project Overview

Discord bot that exposes Claude Code capabilities through Discord slash commands. Built on two dependencies only: `discord.js` and `@anthropic-ai/claude-agent-sdk`. Runs on Deno via `npx deno`.

## Architecture

```
Discord slash command
  → core/handler-registry.ts       (route + build query options)
  → claude/client.ts               (SDK query with MCP/settings/permissions)
  → @anthropic-ai/claude-agent-sdk (streaming async generator)
  → claude/discord-sender.ts       (orchestrate status line + dispatch to renderers)
    → claude/sender-renderers.ts   (per-message-type → MessageContent)
    → claude/sender-utils.ts       (pure helpers: truncate, format, constants)
  → discord/message-sender.ts      (MessageContent → Discord.js API calls)
```

Key directories:
- `claude/` — SDK integration: query execution, streaming, model registry, permissions, MCP loading
  - `client.ts` — low-level SDK wrapper (builds options, streams)
  - `enhanced-client.ts` — session manager, model registry, templates
  - `discord-sender.ts` — orchestrator: status line + renderer dispatch
  - `sender-renderers.ts` — per-message-type render functions
  - `sender-utils.ts` — pure utility functions and constants
  - `query-manager.ts` — active query state, rewind, info retrieval
  - `hooks.ts` — passive SDK callbacks for observability
  - `user-question.ts` — AskUserQuestion embed/button building
  - `permission-request.ts` — tool permission Allow/Deny embeds
- `core/` — Bot infrastructure: config, signal handling, RBAC, handler wiring
  - `config-loader.ts` — env + CLI arg parsing
  - `handler-registry.ts` — session state, command routing
  - `bot-factory.ts` — manager creation, context assembly
  - `signal-handler.ts` — SIGINT/SIGTERM graceful shutdown
  - `workspace-manager.ts` — channelId → workDir registry
  - `env-loader.ts` — .env file reader
- `discord/` — Discord layer: message sending, threads, pagination, formatting
  - `bot.ts` — Discord.js client creation and event routing
  - `message-sender.ts` — MessageContent → Discord.js payloads
  - `session-threads.ts` — session↔thread mapping persistence
  - `session-thread-callbacks.ts` — connects Claude sessions to threads
  - `ask-user-handler.ts` — interactive question flow via buttons
  - `permission-handler.ts` — tool permission flow via buttons
  - `pagination.ts` — paginated embeds with navigation
- `settings/` — Unified settings state and `/settings` command handlers
- `system/` — System monitoring commands (processes, disk, network, etc.)
- `shell/` — Shell command execution via Discord
- `agent/` — Built-in agent personas (code-review, debug, architect, etc.)
- `workspace/` — Multi-workspace slash command handlers (`/workspace add|remove|list`)
- `admin/` — Local HTTP admin server (localhost:7860) for workspace management UI

## Config Injection

At session start, the SDK query loads:
- `.claude/mcp.json` — MCP servers (auto-injected, all `mcp__*` tools auto-approved)
- `CLAUDE.md` — project instructions (this file)
- `settings.local.json` — local settings
- User-level `~/.claude/` settings via `settingSources: ['project', 'local', 'user']`

## Runtime

- **Runtime:** Deno (via `npx deno`, no global install required)
- **Entry:** `index.ts`
- **Start:** `./start.sh start` (production daemon) or `npx deno task start`
- **Auth:** AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) or Anthropic API key
- **Platform:** Linux / macOS only (no Windows support)

## Development Commands

```bash
npx deno task start     # run bot
npx deno task dev       # run with hot reload
npx deno check index.ts # type check
npx deno lint           # lint
npx deno fmt            # format
```

## Multi-Workspace

A single bot instance can manage multiple project channels, each with its own working directory:

- **Workspace registry:** `core/workspace-manager.ts` — maps channelId → workDir, persisted in `.bot-data/workspaces.json`
- **Commands:** `/workspace add <name> <path>`, `/workspace remove <name>`, `/workspace list`
- **Admin UI:** HTTP server on `localhost:7860` for workspace CRUD (no auth, localhost only)
- **Per-channel session state:** `ClaudeSessionOps` tracks controllers and session IDs per-channel via Maps (not global singletons), enabling safe concurrent sessions across workspaces
- **Thread auto-resume:** Works in all workspace channels, resolves workDir from the thread's parent channel

## Code Conventions

- TypeScript strict mode, Deno APIs (not Node.js unless unavoidable)
- Imports: `npm:` specifiers in `deno.json`, Deno std via URL imports
- No third-party packages beyond discord.js and claude-agent-sdk
- Permission mode default: `acceptEdits` (allows file edits, prompts for others)
- Hidden message types: system, tool_use, tool_result, tool_progress are hidden by default, shown via `/show-*` toggle commands
- Session persistence: thread mappings stored in `.bot-data/session-threads.json`
- Workspace persistence: workspace registry stored in `.bot-data/workspaces.json`

## Important Patterns

- **MCP auto-allow:** Any tool starting with `mcp__` is auto-approved in `canUseTool` callback (`claude/client.ts:263`)
- **Status line:** Single editable Discord message that tracks hidden tool activity, auto-repositions below new visible content (`claude/discord-sender.ts`)
- **Thread auto-resume:** Plain text in a session thread triggers automatic Claude resume via Message Content Intent (`index.ts`). Works across all workspace channels.
- **Workspace routing:** `workspaceManager.resolve(channelId)` resolves the correct working directory for any channel. Falls back to default `WORK_DIR`.
- **Crash handler:** `process/crash-handler.ts` registers SIGINT/SIGTERM, manages graceful shutdown (calls `abortAll()` to cancel all active sessions)
- **File delivery via marker:** The model outputs `[FILE:/absolute/path]` markers when the user asks for a file. The Discord sender detects these markers, strips them from displayed text, and delivers the file as an attachment or preview. Implementation: `claude/discord-sender.ts` (regex + preview logic), `claude/bot-system-prompt.ts` (model instructions, injected as `appendSystemPrompt` on every query).

## Environment Variables

Required: `DISCORD_TOKEN`, `APPLICATION_ID`

Key optional: `GUILD_ID` (instant slash command registration), `CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`, `AWS_REGION`, `ANTHROPIC_MODEL`, `ADMIN_USER_IDS`

Full reference in `.env.example`.
