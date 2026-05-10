# Hot Query — Streaming Input Mode for Session Threads

## Problem

Every Discord message in a session thread currently pays a 2–3 second cold
start: `claude/client.ts` calls `claudeQuery({ prompt: string, ... })`, which
spawns a fresh `claude` Node subprocess, reloads MCP servers, settings sources,
the Claude Code system prompt preset, and CLAUDE.md — then streams one turn and
exits. The SDK wrapper gives us nothing over shelling out to the `claude` CLI,
because we re-pay the init cost per message.

## Goal

Eliminate cold-start latency for the second and subsequent messages in a
session thread by keeping one long-running `Query` object alive per session
thread and pushing new prompts into its streaming input channel.

## Non-Goals

- First-message latency in a new session thread (still pays cold start).
- Non-thread commands (`/ask`, `/claude` in a channel root) — they remain on
  the existing cold path.
- Any change to the Anthropic SDK dependency set. We continue to use
  `@anthropic-ai/claude-agent-sdk`.
- Process pooling across threads. Each hot query is bound to one session.

## Approach

`claudeQuery({ prompt, ... })` accepts `prompt: AsyncIterable<SDKUserMessage>`
in addition to `string`. When the iterator does not terminate, the SDK
subprocess, MCP connections, and loaded CLAUDE.md stay resident. We build an
`AsyncPushQueue` that can be driven externally, create one `Query` per session
thread, and push each new prompt as a `SDKUserMessage` into the queue.

### Core Model

One `HotQuerySession` per session thread, tracked by Claude session UUID:

```
SessionThread (Discord thread)
  ↔ sessionId (Claude session UUID, from session-threads.json)
    ↔ HotQuerySession {
        query: Query,                    // live SDK Query
        inputQueue: AsyncPushQueue,      // external push → SDK pull
        consumerPromise: Promise<void>,  // perpetual `for await` over query
        currentTurn: Turn | null,        // exactly one turn at a time
        workDir: string,
        sessionId: string,
        lastActivityAt: number,
        boundOptions: ClaudeModelOptions // immutable fields captured at create
    }
```

Invariant: at most one turn runs per hot query at any time. A turn starts when
a prompt is pushed to the queue and ends when a `type: "result"` SDK message is
observed.

### Lifecycle

1. **Create** — First message in a session thread, no existing hot query.
   Call SDK `claudeQuery({ prompt: asyncIterable, options })`, start the
   consumer loop, pay the 2–3 s cold start, record `lastActivityAt`.
2. **Reuse** — Subsequent messages hit the existing hot query. Push the prompt
   as a `SDKUserMessage` and await the turn’s `resolve`. No cold start.
3. **Idle reclaim** — After `HOT_QUERY_IDLE_MS` without activity, close the
   query and remove it from the registry.
4. **Fail** — Consumer loop throws or iterator ends unexpectedly. Mark the
   registry entry removed; next message rebuilds.
5. **Shutdown** — `signal-handler.ts` calls `registry.closeAll()` during
   SIGINT/SIGTERM.

### Turn Boundaries

`claude/client.ts` is split into two roles:

- **Long-lived consumer loop** per hot query:
  ```
  for await (const msg of query) {
    dispatch(msg, currentTurn)           // onChunk / onStreamJson / onTyping
    if (msg.type === "result") {
      currentTurn.resolve({ cost, duration, sessionId, response, denials })
      currentTurn = null
    }
  }
  ```
- **Per-turn promise** returned by `runTurn(prompt, controller, callbacks)`.
  Pushes the prompt onto `inputQueue`, sets `currentTurn`, returns a promise
  that resolves on the next `result` message.

### Concurrency — Same Thread, Second Message While First Runs

Policy: **reject**. `runTurn` rejects with a `Busy` error if `currentTurn !==
null`. The upstream handler surfaces the existing "a turn is running, use
/stop or the abort button" UX. Matches the current behavior where
`setActiveQuery` already single-tracks per channel.

### Abort Semantics

A turn’s `controller.abort()` calls `query.interrupt()` — **not**
`query.close()`. The consumer loop stays alive waiting for the next turn. Only
idle timeout, process crash, recreate, or shutdown actually close the query.

### Config Drift — Reuse vs Recreate

Some SDK options are baked in at subprocess start and cannot be changed on a
live `Query`; others have dedicated setters. `HotQuerySession.prepareForTurn`
compares the incoming options against `boundOptions`:

| Option                | Strategy                                           |
| --------------------- | -------------------------------------------------- |
| `model`               | `query.setModel()` → reuse                         |
| `permissionMode`      | `query.setPermissionMode()` → reuse                |
| Dynamic MCP changes   | `query.setMcpServers()` / `toggleMcpServer()`      |
| `cwd`                 | recreate                                           |
| `systemPrompt` / `appendSystemPrompt` | recreate                           |
| `agent` / `agents`    | recreate                                           |
| `betas`               | recreate                                           |
| `sandbox`             | recreate                                           |
| `thinking` / `effort` | recreate                                           |
| `additionalDirectories` | recreate                                         |
| `enableFileCheckpointing` | recreate                                       |

Recreate = close the current hot query (reason `recreate`), create a new one
with the new options. The user pays cold start again but only when they
explicitly changed a setting that warrants it.

### Registry

New file `claude/hot-query-registry.ts`:

```ts
class HotQueryRegistry {
  private sessions = new Map<string, HotQuerySession>()
  private idleTimers = new Map<string, number>()

  get(sessionId): HotQuerySession | undefined
  create(sessionId, workDir, options, onEvict): HotQuerySession
  touch(sessionId): void           // reset idle timer, update lastActivityAt
  close(sessionId, reason): void   // close query, clear timer, delete entry
  closeAll(reason): void           // SIGINT/SIGTERM
  list(): HotQuerySessionSummary[] // for /hot-queries
}
```

- `HOT_QUERY_MAX_SESSIONS` default **3**. When reaching the cap on `create()`,
  evict the least-recently-active entry first, then create.
- On LRU eviction, send a one-line notice to the evicted session’s Discord
  thread: `🧊 会话已进入休眠以释放资源，下一条消息将正常处理（首条会多等 2-3s 冷启动）`.
  The registry does not import Discord directly; the caller passes a
  thread-resolver callback (`sessionId → channelId`) and the Discord sender is
  invoked at the call site.

### Integration Point

`core/handler-registry.ts` decides per incoming message:

```ts
if (isSessionThread && Deno.env.get("HOT_QUERY_ENABLED") !== "false") {
  const hot = registry.get(sessionId) ??
    registry.create(sessionId, workDir, options)
  return hot.runTurn(prompt, controller, callbacks)
}
return sendToClaudeCode(...)   // existing cold path
```

`claude/client.ts` keeps `sendToClaudeCode` for the cold path. The new
`HotQuerySession` reuses the same `canUseTool`, MCP loading, env var, and
system-prompt-config builders extracted from `sendToClaudeCode`. No duplication:
extract the option-building logic into a shared `buildQueryOptions()` helper
used by both paths.

## Configuration

| Env var                    | Default         | Purpose                          |
| -------------------------- | --------------- | -------------------------------- |
| `HOT_QUERY_ENABLED`        | `true`          | Master switch; `false` = all cold |
| `HOT_QUERY_IDLE_MS`        | `900000` (15m)  | Idle reclaim threshold            |
| `HOT_QUERY_MAX_SESSIONS`   | `3`             | Registry cap; LRU evict on cap    |

Document these in `.env.example` alongside the existing bot env vars.

## Observability

- `[HotQuery] session=<id> created (cold-init: <ms>ms)`
- `[HotQuery] session=<id> reused (skip cold-init)`
- `[HotQuery] session=<id> closed (reason: idle|shutdown|recreate|error|lru)`
- New minimal Discord command `/hot-queries` — lists active entries with
  (sessionId, threadName, idleFor, lastModel). Reuses existing command
  registration pattern from `claude/info-commands.ts`.

## Testing

Follow the project's colocated `*_test.ts` convention. Add tests for:

- `AsyncPushQueue` — push/pull ordering, buffered push, close semantics,
  push-after-close behavior, concurrent pending iterators.
- `HotQueryRegistry` — LRU eviction at cap, idle timer reset on `touch`,
  `close` clears timer, `closeAll` empties the map, eviction callback fires.
- `HotQuerySession.prepareForTurn` — given two option sets, returns the
  expected `reuse` vs `recreate` verdict for each field in the table above.
- Turn boundary detection — given a stream of mocked SDK messages ending in
  `type: "result"`, the turn promise resolves with the extracted
  cost/duration/sessionId/denials.
- Concurrency policy — second `runTurn` while first is in flight rejects with
  `Busy`.

Integration-style tests that spawn a real `claude` subprocess are out of
scope; rely on existing manual testing in the Discord bot.

## Migration & Rollback

- `HOT_QUERY_ENABLED=false` disables the feature entirely; all paths fall back
  to `sendToClaudeCode`. Safe rollback without code revert.
- No persisted state format changes. `session-threads.json` stays as is.
- No changes to user-facing slash commands except the new `/hot-queries`.

## Risks

- **Memory** — each hot query is a Node subprocess (~100 MB). Cap of 3 keeps
  worst-case at ~300 MB of subprocess memory, which is acceptable.
- **Staleness** — changes to `CLAUDE.md` or `.claude/mcp.json` during a live
  hot query are not reflected until recreate. Mitigation: LRU + idle timeout
  keeps hot queries short-lived in practice. A `/hot-queries refresh` flag
  can be added later if needed; not in v1.
- **SDK behavior gap** — we rely on `claudeQuery` keeping the subprocess alive
  while the input iterator is pending. If a future SDK version adds an idle
  timeout on the iterator side, the feature degrades to cold-path behavior —
  detected by hot query close events and logged.
