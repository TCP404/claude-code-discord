# Changelog

## v3.0.0

### Breaking Changes

- refactor: remove `enhanced-client.ts` and all related dead code — session management now handled directly by `client.ts`
- refactor: remove `/resume` command and Continue button — thread auto-resume replaces both

### Hot Query (Streaming-Input Reuse)

- feat: add `HotQuerySession` with `AsyncPushQueue` for streaming-input mode
- feat: add `HotQueryRegistry` with LRU eviction and idle timeout
- feat: route session thread messages through hot query when `HOT_QUERY_ENABLED=true` (default)
- feat: close hot queries gracefully on SIGINT/SIGTERM
- feat: add `/hot-queries` observability command
- feat: env-var driven config (`HOT_QUERY_ENABLED`, `HOT_QUERY_MAX_SESSIONS`, `HOT_QUERY_IDLE_TIMEOUT_MS`, `HOT_QUERY_TYPING_INTERVAL_MS`)
- fix: refresh Discord typing indicator during in-flight turns

### Multi-Bot & Mention-Only

- feat: multi-bot coexistence — skip messages that @mention another bot but not us (PR #6 @jj0012006)
- feat: `THREAD_MENTION_ONLY` env var — only respond in threads when explicitly @mentioned (PR #7 @jj0012006)

### Safety & Reliability

- feat: add safety rules to bot system prompt (no `find /`, no secret leakage, no destructive commands, no unsolicited `git push`)
- fix: reliable process stop — kill child processes via `pkill -P`, fallback to SIGKILL (PR #5 @mao)
- feat: add `/restart` Discord command

### Code Quality

- refactor: extract large modules into focused single-responsibility files
- refactor: add JSDoc `@module` headers to all files, consolidate types, eliminate barrel indirection
- refactor: extract `buildQueryOptions` and `buildCanUseTool` helpers from client.ts
- feat: add workspace auto-thread mode for plain text messages
- feat: `DEFAULT_PERMISSION_MODE` env var for session defaults
- test: add 238 unit tests covering core logic, utilities, and orchestration
- fix: remove all 55 unused-vars lint warnings
- style: apply `deno fmt` to entire codebase
- docs: update all documentation to reflect v3.0 architecture

## v2.4.2

- refactor: replace auto file detection with explicit `[FILE:]` marker system
- fix: improve file path detection and extend cleanup threshold
- fix: remove automatic session thread cleanup

## v2.4.1

### PR #4 — UX Enhancements (@jj0012006)

- feat: multi-type inline file preview (images, PDF, code, CSV) replaces button-only upload
- feat: session usage tracking — cumulative cost/duration shown in completion embed
- feat: typing indicator during Claude SDK queries (8s interval)
- feat: `createClaudeSender` returns `{ send, setSessionId }` for per-session cost tracking
- chore: format all files with `deno fmt` (single→double quotes, trailing commas)

### Bugfix

- fix: tighten file path regex to require `./` or `/` prefix, avoiding false positive previews on bare filenames
- fix: skip `node_modules` paths in auto-upload file detection
- fix: remove unused variables (`embedData`, `fileInfo`) in discord-sender

## v2.4.0

### PR #3 — Multi-Workspace Support (@PengWei)

- feat: multi-workspace support — single bot instance manages multiple project channels
- feat: add admin HTTP server module (Deno.serve on localhost:7860)
- feat: add delete session button in admin UI
- fix: per-channel session state to prevent concurrent workspace conflicts
- fix: thread auto-resume works across all channels, add error feedback
- fix: always delete Discord channel when removing workspace, cleanup orphans on startup
- fix: admin workspace creation auto-creates channel instead of requiring selection
- fix: allow thread auto-resume in workspace channels

### PR #2 — Voice Message Recognition & File Upload (@jj0012006)

- feat: add voice message transcription via OpenAI Whisper
- feat: button-based file upload instead of auto-sending
- fix: deduplicate file paths in auto-upload to prevent repeated sends
- fix: extract text from array-type tool_result content blocks
- fix: support relative paths in auto-upload file detection
- fix: auto-upload files from tool_result even when hidden
- fix: add `--yes` flag to npx to avoid interactive prompt in daemon mode
- chore: save screenshots to `./screenshots/` dir, add to gitignore
