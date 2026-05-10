# Architecture

## Project Structure

```
claude-code-discord/
├── index.ts                    # Entry point: assembly and startup only
├── deno.json                   # Deno configuration
├── .env                        # Environment variables (not committed)
├── .claude/mcp.json            # MCP server configuration
│
├── claude/                     # Claude SDK integration
│   ├── types.ts                # Shared types (ClaudeMessage, DiscordSender, RendererContext)
│   ├── client.ts               # Low-level SDK wrapper: builds query options, streams responses
│   ├── enhanced-client.ts      # Session manager, model registry, template support
│   ├── discord-sender.ts       # Orchestrator: status line management + renderer dispatch
│   ├── sender-renderers.ts     # Per-message-type render functions → MessageContent
│   ├── sender-utils.ts         # Pure helpers: truncate, format, constants
│   ├── command.ts              # /ask slash command (simple single-turn query)
│   ├── enhanced-commands.ts    # /claude slash command with model/template/thinking options
│   ├── additional-commands.ts  # Extra slash commands (quick-query, template, etc)
│   ├── message-converter.ts    # SDK JSON stream → ClaudeMessage[]
│   ├── model-fetcher.ts        # Dynamic model fetching (API + CLI)
│   ├── query-manager.ts        # Active query lifecycle, rewind, info retrieval
│   ├── info-commands.ts        # /claude-info, /rewind, /claude-control
│   ├── hooks.ts                # Passive SDK callbacks for observability
│   ├── user-question.ts        # AskUserQuestion embed/button building
│   ├── permission-request.ts   # Tool permission Allow/Deny embeds
│   ├── file-preview.ts         # File preview generation (images, PDFs, code)
│   ├── session-usage.ts        # Per-session cost and query count tracking
│   └── bot-system-prompt.ts    # System prompt injected on every query
│
├── core/                       # Bot infrastructure
│   ├── config-loader.ts        # Env + CLI arg parsing → AppConfig
│   ├── handler-registry.ts     # Session state, command routing, query options
│   ├── bot-factory.ts          # Manager creation, context assembly
│   ├── signal-handler.ts       # SIGINT/SIGTERM graceful shutdown
│   ├── workspace-manager.ts    # channelId → workDir registry
│   ├── env-loader.ts           # .env file reader
│   ├── button-handlers.ts      # Discord button interaction routing
│   ├── command-wrappers.ts     # Factory functions for command handlers
│   ├── git-shell-handlers.ts   # Git/shell command handler factories
│   └── rbac.ts                 # Role-based access control
│
├── discord/                    # Discord layer
│   ├── types.ts                # Shared types (BotConfig, MessageContent, EmbedData, etc)
│   ├── bot.ts                  # Discord.js client creation, event routing
│   ├── message-sender.ts       # MessageContent → Discord.js API calls
│   ├── session-threads.ts      # Session↔thread mapping persistence
│   ├── session-thread-callbacks.ts  # Connects Claude sessions to threads
│   ├── ask-user-handler.ts     # Interactive question flow via buttons
│   ├── permission-handler.ts   # Tool permission flow via buttons
│   ├── pagination.ts           # Paginated embeds with navigation
│   ├── formatting.ts           # Rich text formatting for code/git output
│   └── utils.ts                # Text splitting, channel name sanitization
│
├── settings/                   # Settings management
│   ├── unified-settings.ts     # Settings types, defaults, slash command
│   ├── unified-handlers.ts     # Unified /settings interaction handlers
│   ├── advanced-settings.ts    # Legacy settings (deprecated)
│   └── handlers.ts             # Legacy settings handlers
│
├── agent/                      # Built-in agent personas
│   └── index.ts                # /agent command: code-review, debug, architect, etc
│
├── git/                        # Git operations
│   ├── types.ts                # GitInfo, worktree types
│   ├── handler.ts              # Git command execution (status, diff, log, worktree)
│   ├── command.ts              # /git slash command
│   └── process-manager.ts      # Worktree bot child process management
│
├── shell/                      # Shell execution
│   ├── types.ts                # ShellProcess, ShellExecutionResult
│   ├── handler.ts              # ShellManager: spawn, track, kill processes
│   └── command.ts              # /shell slash command
│
├── system/                     # System monitoring
│   ├── commands.ts             # Command definitions
│   └── index.ts                # Handlers (processes, disk, network, memory)
│
├── workspace/                  # Multi-workspace management
│   └── command.ts              # /workspace add|remove|list
│
├── admin/                      # Admin HTTP server (localhost:7860)
│   ├── server.ts               # HTTP listener, CORS
│   ├── routes.ts               # REST endpoints
│   └── html.ts                 # Embedded admin UI
│
├── util/                       # Utilities
│   ├── version-check.ts        # Startup version comparison
│   ├── platform.ts             # OS detection, platform-specific commands
│   ├── process.ts              # Cross-platform process kill
│   ├── proxy.ts                # HTTP/SOCKS proxy configuration
│   ├── persistence.ts          # JSON file persistence helpers
│   └── usage-tracker.ts        # API usage tracking
│
├── process/                    # Process management
│   └── crash-handler.ts        # Crash recovery, health monitoring
│
├── help/                       # Help system
│   └── commands.ts             # /help command
│
├── screenshot/                 # Screenshot capture
│   ├── handler.ts              # Screen capture logic
│   └── command.ts              # /screenshot command
│
├── docs/                       # Documentation
│   ├── setup-discord.md        # Discord bot setup tutorial
│   ├── commands.md             # Command reference
│   ├── features.md             # Feature details
│   ├── architecture.md         # This file
│   └── updating.md             # Update instructions
│
├── start.sh                    # Production daemon (start/stop/restart)
├── CLAUDE.md                   # Project instructions for Claude Code
│
│   # Test files (colocated, pattern: *_test.ts)
│   # claude/sender-utils_test.ts
│   # claude/message-converter_test.ts
│   # discord/utils_test.ts
│   # discord/formatting_test.ts
│   # core/workspace-manager_test.ts
```

## SDK Integration

Built on `@anthropic-ai/claude-agent-sdk`.

### Data Flow

```
Discord slash command / thread message
  → core/handler-registry.ts   (route command, build query options)
  → claude/enhanced-client.ts  (create SDK query with model/settings)
  → @anthropic-ai/claude-agent-sdk  (streaming async generator)
  → claude/message-converter.ts     (SDK JSON → ClaudeMessage[])
  → claude/discord-sender.ts        (orchestrate: status line + dispatch)
    → claude/sender-renderers.ts    (per-type → MessageContent)
  → discord/message-sender.ts       (MessageContent → Discord.js API)
```

### Key SDK Features Used

| Feature     | Implementation                                                   |
| ----------- | ---------------------------------------------------------------- |
| Streaming   | `Query` async generator yields `SDKMessage` objects              |
| Models      | `query.supportedModels()` for runtime discovery                  |
| Agents      | `AgentDefinition` with system prompts passed via `agents` option |
| Permissions | `query.setPermissionMode()` for mid-session changes              |
| Model Swap  | `query.setModel()` for mid-session model changes                 |
| Rewind      | `query.rewindFiles(messageId)` for file change rollback          |
| Info        | `query.accountInfo()`, `query.initializationResult()`            |
| MCP         | `query.mcpServerStatus()`, `query.setMcpServers()`               |
| Interrupts  | `query.interrupt()` for cancellation                             |
| Sessions    | `persistSession: true` for conversation continuity               |

### Settings Pipeline

```
User sets value via /settings
  → unified-settings.ts (update + persist)
  → handler-registry.ts getQueryOptions() reads settings
  → ClaudeModelOptions built with all current values
  → enhanced-client.ts passes to SDK query
```

Settings include: model, thinking mode, effort level, system prompt, operation mode, git context, output format, sandbox mode, file checkpointing, 1M context beta.
