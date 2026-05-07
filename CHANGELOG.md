# Changelog

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
