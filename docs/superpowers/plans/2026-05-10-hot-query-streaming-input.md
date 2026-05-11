# Hot Query — Streaming Input Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one long-running `Query` per session thread so the second and subsequent messages skip the 2–3 s SDK cold start.

**Architecture:** New `claude/hot-query.ts` module owns an `AsyncPushQueue` and a `HotQuerySession` class. `claude/hot-query-registry.ts` manages `sessionId → HotQuerySession` with LRU + idle eviction. `core/handler-registry.ts` integration point picks hot path vs cold path per message. `claude/client.ts` gets a shared `buildQueryOptions()` helper used by both paths.

**Tech Stack:** Deno + TypeScript strict, `@anthropic-ai/claude-agent-sdk` v0.2.119+ (supports `query({ prompt: AsyncIterable<SDKUserMessage> })`), colocated `*_test.ts` using `Deno.test` + `assertEquals`.

**Spec:** `docs/superpowers/specs/2026-05-10-hot-query-streaming-input-design.md`

---

## File Structure

**New files:**
- `claude/hot-query.ts` — `AsyncPushQueue<T>`, `HotQuerySession` class, `runTurn`, consumer loop
- `claude/hot-query_test.ts` — `AsyncPushQueue` + `HotQuerySession.prepareForTurn` tests
- `claude/hot-query-registry.ts` — `HotQueryRegistry` class (LRU, idle timers, eviction callback)
- `claude/hot-query-registry_test.ts` — LRU, idle timer, `closeAll` tests

**Modified files:**
- `claude/client.ts` — extract `buildQueryOptions()` + `buildCanUseTool()` helpers; keep cold path
- `core/handler-registry.ts` — env var reading + `HotQueryRegistry` instance
- `index.ts` — thread message handler routes through `HotQueryRegistry`
- `core/signal-handler.ts` — add `closeHotQueries` to `CleanupContext`
- `.env.example` — document new env vars
- `CLAUDE.md` — mention new module

---

## Task 1: AsyncPushQueue

**Files:**
- Create: `claude/hot-query.ts`
- Create: `claude/hot-query_test.ts`

- [ ] **Step 1: Write failing test**

Write to `claude/hot-query_test.ts`:

```ts
/** @module claude/hot-query_test — Tests for AsyncPushQueue and HotQuerySession. */
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AsyncPushQueue } from "./hot-query.ts";

Deno.test("AsyncPushQueue: push-then-pull delivers items in order", async () => {
  const q = new AsyncPushQueue<number>();
  q.push(1);
  q.push(2);
  q.push(3);
  const iter = q[Symbol.asyncIterator]();
  assertEquals((await iter.next()).value, 1);
  assertEquals((await iter.next()).value, 2);
  assertEquals((await iter.next()).value, 3);
});

Deno.test("AsyncPushQueue: pull-then-push resolves the pending promise", async () => {
  const q = new AsyncPushQueue<number>();
  const iter = q[Symbol.asyncIterator]();
  const pending = iter.next();
  q.push(42);
  const result = await pending;
  assertEquals(result.value, 42);
  assertEquals(result.done, false);
});

Deno.test("AsyncPushQueue: close resolves pending pulls with done=true", async () => {
  const q = new AsyncPushQueue<number>();
  const iter = q[Symbol.asyncIterator]();
  const pending = iter.next();
  q.close();
  const result = await pending;
  assertEquals(result.done, true);
});

Deno.test("AsyncPushQueue: push after close is a no-op", async () => {
  const q = new AsyncPushQueue<number>();
  q.close();
  q.push(1);
  const iter = q[Symbol.asyncIterator]();
  assertEquals((await iter.next()).done, true);
});

Deno.test("AsyncPushQueue: buffered items drained before done", async () => {
  const q = new AsyncPushQueue<number>();
  q.push(1);
  q.push(2);
  q.close();
  const iter = q[Symbol.asyncIterator]();
  assertEquals((await iter.next()).value, 1);
  assertEquals((await iter.next()).value, 2);
  assertEquals((await iter.next()).done, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx deno test --allow-all --no-lock claude/hot-query_test.ts`
Expected: FAIL — "Module not found" for `./hot-query.ts`.

- [ ] **Step 3: Implement AsyncPushQueue**

Write to `claude/hot-query.ts`:

```ts
/** @module claude/hot-query — AsyncPushQueue + HotQuerySession for streaming-input mode. */

/**
 * An async iterable driven by external `push()` calls. Pending `.next()` promises
 * resolve as soon as an item is pushed. After `close()`, all pending and future
 * `.next()` calls resolve with `{ done: true }`.
 */
export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private pending: Array<(r: IteratorResult<T>) => void> = [];
  private buffer: T[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.pending.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.pending) {
      w({ value: undefined as unknown as T, done: true });
    }
    this.pending = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.pending.push(resolve));
      },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx deno test --allow-all --no-lock claude/hot-query_test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add claude/hot-query.ts claude/hot-query_test.ts
git commit -m "feat: add AsyncPushQueue for streaming-input mode"
```

---

## Task 2: Extract buildQueryOptions from client.ts

**Files:**
- Modify: `claude/client.ts:216-369`

This extracts the option-building logic so both the cold path (`sendToClaudeCode`) and the new hot path can share it. No behavior change — refactor only.

- [ ] **Step 1: Add buildCanUseTool helper**

Insert after `extractPermissionDenials` in `claude/client.ts` (around line 82):

```ts
/** Build the canUseTool callback used by both cold and hot query paths. */
export function buildCanUseTool(
  modelOptions?: ClaudeModelOptions,
): (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<
  { behavior: "allow"; updatedInput: Record<string, unknown> } | {
    behavior: "deny";
    message: string;
  }
> {
  const readOnlyTools = new Set([
    "Read",
    "Glob",
    "Grep",
    "Skill",
    "ToolSearch",
    "WebFetch",
    "WebSearch",
    "LSP",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TaskStop",
    "TaskOutput",
    "Agent",
    "EnterPlanMode",
    "ExitPlanMode",
    "Bash",
    "Write",
    "Edit",
    "NotebookEdit",
  ]);

  return async (toolName: string, input: Record<string, unknown>) => {
    if (readOnlyTools.has(toolName)) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (toolName === "AskUserQuestion" && modelOptions?.onAskUser) {
      try {
        const askInput = input as unknown as AskUserQuestionInput;
        const answers = await modelOptions.onAskUser(askInput);
        return {
          behavior: "allow" as const,
          updatedInput: { questions: askInput.questions, answers },
        };
      } catch (err) {
        console.error("[AskUserQuestion] Failed to collect answers:", err);
        return { behavior: "deny" as const, message: "User did not respond in time" };
      }
    }
    if (toolName.startsWith("mcp__")) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (modelOptions?.onPermissionRequest) {
      try {
        const allowed = await modelOptions.onPermissionRequest(toolName, input);
        if (allowed) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        return { behavior: "deny" as const, message: `User denied tool: ${toolName}` };
      } catch (err) {
        console.error(`[PermissionRequest] Error for ${toolName}:`, err);
        return {
          behavior: "deny" as const,
          message: `Permission request failed for: ${toolName}`,
        };
      }
    }
    return { behavior: "deny" as const, message: `Tool ${toolName} not pre-approved` };
  };
}
```

- [ ] **Step 2: Add buildQueryOptions helper**

Insert right after `buildCanUseTool`:

```ts
/** Build the `options` block for claudeQuery({ prompt, options }). */
export async function buildQueryOptions(
  workDir: string,
  modelOptions: ClaudeModelOptions | undefined,
  resumeSessionId: string | undefined,
  controller: AbortController,
): Promise<{
  cwd: string;
  abortController: AbortController;
  permissionMode: SDKPermissionMode;
  // deno-lint-ignore no-explicit-any
  options: any;
}> {
  const mcpServers = await loadMcpServers(workDir);
  const permMode: SDKPermissionMode = modelOptions?.permissionMode ||
    (Deno.env.get("DEFAULT_PERMISSION_MODE") as SDKPermissionMode | undefined) ||
    "acceptEdits";

  const envVars: Record<string, string> = {
    ...Object.fromEntries(Object.entries(Deno.env.toObject())),
    CLAUDE_CODE_ENABLE_TASKS: "1",
    ...(modelOptions?.enableAgentTeams && { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }),
  };
  if (modelOptions?.extraEnv) Object.assign(envVars, modelOptions.extraEnv);

  const systemPromptConfig = modelOptions?.appendSystemPrompt
    ? {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: modelOptions.appendSystemPrompt,
    }
    : { type: "preset" as const, preset: "claude_code" as const };

  const options = {
    cwd: workDir,
    permissionMode: permMode,
    systemPrompt: systemPromptConfig,
    settingSources: ["project" as const, "local" as const, "user" as const],
    ...(modelOptions?.thinking && { thinking: modelOptions.thinking }),
    ...(modelOptions?.effort && { effort: modelOptions.effort }),
    ...(modelOptions?.maxBudgetUsd && { maxBudgetUsd: modelOptions.maxBudgetUsd }),
    ...(permMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
    ...(resumeSessionId && { resume: resumeSessionId }),
    ...(modelOptions?.model && { model: modelOptions.model }),
    ...(modelOptions?.maxTurns && { maxTurns: modelOptions.maxTurns }),
    ...(modelOptions?.fallbackModel && { fallbackModel: modelOptions.fallbackModel }),
    ...(modelOptions?.agents && { agents: modelOptions.agents }),
    ...(modelOptions?.agent && { agent: modelOptions.agent }),
    ...(modelOptions?.betas && modelOptions.betas.length > 0 && { betas: modelOptions.betas }),
    ...(modelOptions?.enableFileCheckpointing && { enableFileCheckpointing: true }),
    ...(modelOptions?.sandbox && { sandbox: modelOptions.sandbox }),
    ...(modelOptions?.additionalDirectories &&
      modelOptions.additionalDirectories.length > 0 &&
      { additionalDirectories: modelOptions.additionalDirectories }),
    ...(modelOptions?.forkSession && { forkSession: true }),
    ...(modelOptions?.hooks && Object.keys(modelOptions.hooks).length > 0 &&
      { hooks: modelOptions.hooks }),
    ...(modelOptions?.outputFormat && { outputFormat: modelOptions.outputFormat }),
    ...(mcpServers && { mcpServers }),
    canUseTool: buildCanUseTool(modelOptions),
    env: envVars,
  };

  return { cwd: workDir, abortController: controller, permissionMode: permMode, options };
}
```

- [ ] **Step 3: Switch sendToClaudeCode to use helpers**

In `claude/client.ts`, replace the option-building block inside `executeWithErrorHandling` (roughly lines 219–370, from `const permMode = ...` to the end of `const queryOptions = { ... }`) with:

```ts
const modelToUse = overrideModel || modelOptions?.model;
const built = await buildQueryOptions(
  workDir,
  modelToUse ? { ...modelOptions, model: modelToUse } : modelOptions,
  cleanedSessionId,
  controller,
);
const queryOptions = {
  prompt,
  abortController: built.abortController,
  options: built.options,
};
```

Keep the `console.log(...)` status line, the `claudeQuery(queryOptions)` call, the `setActiveQuery(iterator)` call, and the existing `for await` loop below it untouched.

- [ ] **Step 4: Type check**

Run: `npx deno check index.ts`
Expected: no errors.

- [ ] **Step 5: Run all existing tests**

Run: `npx deno task test`
Expected: all existing tests PASS (no behavior change).

- [ ] **Step 6: Commit**

```bash
git add claude/client.ts
git commit -m "refactor: extract buildQueryOptions and buildCanUseTool helpers"
```

---

## Task 3: HotQuerySession.prepareForTurn decision logic

**Files:**
- Modify: `claude/hot-query.ts`
- Modify: `claude/hot-query_test.ts`

Decide reuse vs recreate for incoming per-turn options. Pure function, no SDK interaction. Tested before wiring up live query.

- [ ] **Step 1: Write failing tests**

Append to `claude/hot-query_test.ts`:

```ts
import { prepareForTurn } from "./hot-query.ts";
import type { ClaudeModelOptions } from "./client.ts";

const base: ClaudeModelOptions = {
  model: "sonnet",
  permissionMode: "acceptEdits",
  appendSystemPrompt: "Discord bot prompt",
};

Deno.test("prepareForTurn: identical options → reuse, no setters", () => {
  const result = prepareForTurn(base, base, "/work/dir", "/work/dir");
  assertEquals(result.verdict, "reuse");
  assertEquals(result.setters, []);
});

Deno.test("prepareForTurn: model change → reuse with setModel", () => {
  const next: ClaudeModelOptions = { ...base, model: "opus" };
  const result = prepareForTurn(base, next, "/work/dir", "/work/dir");
  assertEquals(result.verdict, "reuse");
  assertEquals(result.setters, [{ kind: "setModel", value: "opus" }]);
});

Deno.test("prepareForTurn: permissionMode change → reuse with setPermissionMode", () => {
  const next: ClaudeModelOptions = { ...base, permissionMode: "plan" };
  const result = prepareForTurn(base, next, "/work/dir", "/work/dir");
  assertEquals(result.verdict, "reuse");
  assertEquals(result.setters, [{ kind: "setPermissionMode", value: "plan" }]);
});

Deno.test("prepareForTurn: cwd change → recreate", () => {
  const result = prepareForTurn(base, base, "/old", "/new");
  assertEquals(result.verdict, "recreate");
  assertEquals(result.reason, "cwd");
});

Deno.test("prepareForTurn: appendSystemPrompt change → recreate", () => {
  const next: ClaudeModelOptions = { ...base, appendSystemPrompt: "different" };
  const result = prepareForTurn(base, next, "/w", "/w");
  assertEquals(result.verdict, "recreate");
  assertEquals(result.reason, "appendSystemPrompt");
});

Deno.test("prepareForTurn: thinking change → recreate", () => {
  const next: ClaudeModelOptions = { ...base, thinking: { type: "disabled" } };
  const result = prepareForTurn(base, next, "/w", "/w");
  assertEquals(result.verdict, "recreate");
  assertEquals(result.reason, "thinking");
});

Deno.test("prepareForTurn: both model and permissionMode changed → reuse with two setters", () => {
  const next: ClaudeModelOptions = { ...base, model: "haiku", permissionMode: "plan" };
  const result = prepareForTurn(base, next, "/w", "/w");
  assertEquals(result.verdict, "reuse");
  assertEquals(result.setters.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx deno test --allow-all --no-lock claude/hot-query_test.ts`
Expected: FAIL — `prepareForTurn` not exported.

- [ ] **Step 3: Implement prepareForTurn**

Append to `claude/hot-query.ts`:

```ts
import type { ClaudeModelOptions, SDKPermissionMode } from "./client.ts";

export type PrepareSetter =
  | { kind: "setModel"; value: string | undefined }
  | { kind: "setPermissionMode"; value: SDKPermissionMode };

export type PrepareResult =
  | { verdict: "reuse"; setters: PrepareSetter[] }
  | { verdict: "recreate"; reason: string };

const RECREATE_FIELDS: Array<keyof ClaudeModelOptions> = [
  "appendSystemPrompt",
  "agent",
  "agents",
  "betas",
  "sandbox",
  "thinking",
  "effort",
  "additionalDirectories",
  "enableFileCheckpointing",
];

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Decide whether an incoming turn's options can reuse an existing hot query
 * or require a full recreate.
 */
export function prepareForTurn(
  bound: ClaudeModelOptions | undefined,
  next: ClaudeModelOptions | undefined,
  boundCwd: string,
  nextCwd: string,
): PrepareResult {
  if (boundCwd !== nextCwd) {
    return { verdict: "recreate", reason: "cwd" };
  }
  for (const field of RECREATE_FIELDS) {
    if (!deepEqual(bound?.[field], next?.[field])) {
      return { verdict: "recreate", reason: String(field) };
    }
  }
  const setters: PrepareSetter[] = [];
  if (bound?.model !== next?.model) {
    setters.push({ kind: "setModel", value: next?.model });
  }
  if (bound?.permissionMode !== next?.permissionMode && next?.permissionMode) {
    setters.push({ kind: "setPermissionMode", value: next.permissionMode });
  }
  return { verdict: "reuse", setters };
}
```

- [ ] **Step 4: Run tests**

Run: `npx deno test --allow-all --no-lock claude/hot-query_test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add claude/hot-query.ts claude/hot-query_test.ts
git commit -m "feat: add prepareForTurn reuse/recreate decision"
```

---

## Task 4: HotQuerySession class — create, runTurn, close

**Files:**
- Modify: `claude/hot-query.ts`
- Modify: `claude/hot-query_test.ts`

Wires `AsyncPushQueue` to SDK `query()`, runs the consumer loop, exposes `runTurn`. Uses a **fake SDK query factory** in tests so we don't spawn a real subprocess.

- [ ] **Step 1: Write failing tests**

Append to `claude/hot-query_test.ts`:

```ts
import { HotQuerySession } from "./hot-query.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Fake Query factory — captures pushed prompts, yields scripted messages.
function makeFakeQuery(scripted: SDKMessage[][]) {
  let turnIdx = 0;
  const pushedPrompts: string[] = [];
  let outQueue: AsyncPushQueue<SDKMessage> = new AsyncPushQueue<SDKMessage>();

  const query = {
    pushedPrompts,
    [Symbol.asyncIterator]: () => outQueue[Symbol.asyncIterator](),
    interrupt: () => Promise.resolve(),
    setModel: (_m?: string) => Promise.resolve(),
    setPermissionMode: (_m: string) => Promise.resolve(),
    close: () => outQueue.close(),
  };

  const factory = (inputIter: AsyncIterable<{ message: { content: string } }>) => {
    (async () => {
      for await (const msg of inputIter) {
        pushedPrompts.push(msg.message.content);
        const batch = scripted[turnIdx++] ?? [];
        for (const m of batch) outQueue.push(m);
      }
    })();
    return query;
  };
  return { factory, query };
}

Deno.test("HotQuerySession: first turn resolves on result message", async () => {
  const resultMsg = {
    type: "result",
    session_id: "sess-1",
    total_cost_usd: 0.01,
    duration_ms: 1000,
    subtype: "success",
  } as unknown as SDKMessage;
  const { factory } = makeFakeQuery([[resultMsg]]);
  const session = HotQuerySession.create({
    sessionId: "sess-1",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  const turn = await session.runTurn("hello", new AbortController(), {});
  assertEquals(turn.sessionId, "sess-1");
  assertEquals(turn.cost, 0.01);
  await session.close("test");
});

Deno.test("HotQuerySession: second concurrent turn rejects with Busy", async () => {
  const { factory } = makeFakeQuery([[]]); // no result → turn stays running
  const session = HotQuerySession.create({
    sessionId: "sess-2",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  const first = session.runTurn("hello", new AbortController(), {});
  await assertRejects(
    () => session.runTurn("second", new AbortController(), {}),
    Error,
    "Busy",
  );
  await session.close("test");
  await first.catch(() => {});
});

Deno.test("HotQuerySession: onChunk receives assistant text", async () => {
  const asst = {
    type: "assistant",
    message: { content: [{ type: "text", text: "hi there" }] },
    session_id: "sess-3",
  } as unknown as SDKMessage;
  const done = { type: "result", session_id: "sess-3" } as unknown as SDKMessage;
  const { factory } = makeFakeQuery([[asst, done]]);
  const session = HotQuerySession.create({
    sessionId: "sess-3",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  const chunks: string[] = [];
  await session.runTurn("q", new AbortController(), { onChunk: (t) => chunks.push(t) });
  assertEquals(chunks, ["hi there"]);
  await session.close("test");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx deno test --allow-all --no-lock claude/hot-query_test.ts`
Expected: FAIL — `HotQuerySession` not exported.

- [ ] **Step 3: Implement HotQuerySession**

Append to `claude/hot-query.ts`:

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface TurnCallbacks {
  onChunk?: (text: string) => void;
  // deno-lint-ignore no-explicit-any
  onStreamJson?: (msg: any) => void;
  onTyping?: () => void;
}

export interface TurnResult {
  response: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  modelUsed?: string;
  permissionDenials?: Array<
    { toolName: string; toolUseId: string; toolInput: Record<string, unknown> }
  >;
}

interface ActiveTurn {
  controller: AbortController;
  callbacks: TurnCallbacks;
  response: string;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  abortListener: () => void;
}

// Minimal structural type for the SDK Query shape we use (keeps tests decoupled).
interface QueryLike {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  close(): void;
}

export type QueryFactory = (
  prompt: AsyncIterable<{
    type: "user";
    message: { role: "user"; content: string };
    parent_tool_use_id: null;
    session_id?: string;
  }>,
) => QueryLike;

export interface HotQueryCreateParams {
  sessionId: string;
  workDir: string;
  options: ClaudeModelOptions | undefined;
  queryFactory: QueryFactory;
}

export class HotQuerySession {
  readonly sessionId: string;
  readonly workDir: string;
  boundOptions: ClaudeModelOptions | undefined;
  lastActivityAt: number;

  private query: QueryLike;
  private inputQueue: AsyncPushQueue<{
    type: "user";
    message: { role: "user"; content: string };
    parent_tool_use_id: null;
    session_id?: string;
  }>;
  private currentTurn: ActiveTurn | null = null;
  private closed = false;
  private consumerPromise: Promise<void>;

  private constructor(params: HotQueryCreateParams) {
    this.sessionId = params.sessionId;
    this.workDir = params.workDir;
    this.boundOptions = params.options;
    this.lastActivityAt = Date.now();
    this.inputQueue = new AsyncPushQueue();
    this.query = params.queryFactory(this.inputQueue);
    this.consumerPromise = this.runConsumer();
  }

  static create(params: HotQueryCreateParams): HotQuerySession {
    return new HotQuerySession(params);
  }

  /** Whether a turn is currently in flight. */
  get busy(): boolean {
    return this.currentTurn !== null;
  }

  private async runConsumer(): Promise<void> {
    try {
      for await (const msg of this.query) {
        const turn = this.currentTurn;
        if (!turn) continue; // ignore messages outside a turn

        try {
          turn.callbacks.onStreamJson?.(msg);
        } catch { /* non-critical */ }

        if (
          msg.type === "assistant" &&
          "message" in msg &&
          // deno-lint-ignore no-explicit-any
          (msg as any).message?.content
        ) {
          // deno-lint-ignore no-explicit-any
          const text = ((msg as any).message.content as Array<any>)
            .filter((c) => c?.type === "text")
            .map((c) => c.text)
            .join("");
          if (text) {
            turn.response = text;
            try {
              turn.callbacks.onChunk?.(text);
            } catch { /* non-critical */ }
          }
        }

        if (msg.type === "result") {
          // deno-lint-ignore no-explicit-any
          const r = msg as any;
          const resolved: TurnResult = {
            response: turn.response || "No response received",
            sessionId: r.session_id,
            cost: r.total_cost_usd,
            duration: r.duration_ms,
            modelUsed: this.boundOptions?.model || "Default",
          };
          turn.controller.signal.removeEventListener("abort", turn.abortListener);
          this.currentTurn = null;
          turn.resolve(resolved);
        }
      }
    } catch (err) {
      const turn = this.currentTurn;
      if (turn) {
        turn.controller.signal.removeEventListener("abort", turn.abortListener);
        this.currentTurn = null;
        turn.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async runTurn(
    prompt: string,
    controller: AbortController,
    callbacks: TurnCallbacks,
  ): Promise<TurnResult> {
    if (this.closed) throw new Error("HotQuerySession closed");
    if (this.currentTurn) throw new Error("Busy: previous turn still running");
    this.lastActivityAt = Date.now();

    return new Promise<TurnResult>((resolve, reject) => {
      const abortListener = () => {
        this.query.interrupt().catch(() => {});
      };
      controller.signal.addEventListener("abort", abortListener, { once: true });
      this.currentTurn = {
        controller,
        callbacks,
        response: "",
        resolve,
        reject,
        abortListener,
      };
      this.inputQueue.push({
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    });
  }

  /** Apply in-place setters (model / permissionMode) without recreating. */
  async applySetters(setters: PrepareSetter[]): Promise<void> {
    for (const s of setters) {
      if (s.kind === "setModel") await this.query.setModel(s.value);
      else if (s.kind === "setPermissionMode") await this.query.setPermissionMode(s.value);
    }
    this.boundOptions = { ...(this.boundOptions ?? {}) };
    for (const s of setters) {
      if (s.kind === "setModel") this.boundOptions.model = s.value;
      else if (s.kind === "setPermissionMode") this.boundOptions.permissionMode = s.value;
    }
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const turn = this.currentTurn;
    if (turn) {
      turn.controller.signal.removeEventListener("abort", turn.abortListener);
      this.currentTurn = null;
      turn.reject(new Error(`HotQuerySession closed: ${reason}`));
    }
    this.inputQueue.close();
    try {
      this.query.close();
    } catch { /* ignore */ }
    await this.consumerPromise.catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx deno test --allow-all --no-lock claude/hot-query_test.ts`
Expected: PASS (15 tests total).

- [ ] **Step 5: Commit**

```bash
git add claude/hot-query.ts claude/hot-query_test.ts
git commit -m "feat: add HotQuerySession with runTurn and abort wiring"
```

---

## Task 5: HotQueryRegistry with LRU + idle eviction

**Files:**
- Create: `claude/hot-query-registry.ts`
- Create: `claude/hot-query-registry_test.ts`

- [ ] **Step 1: Write failing tests**

Write to `claude/hot-query-registry_test.ts`:

```ts
/** @module claude/hot-query-registry_test — Tests for HotQueryRegistry. */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { HotQueryRegistry } from "./hot-query-registry.ts";
import { HotQuerySession } from "./hot-query.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function makeFakeSession(sessionId: string): HotQuerySession {
  const factory = () => ({
    [Symbol.asyncIterator]: async function* () {
      await new Promise(() => {}); // never yields
      yield {} as SDKMessage;
    },
    interrupt: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    setPermissionMode: () => Promise.resolve(),
    close: () => {},
  });
  return HotQuerySession.create({
    sessionId,
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
}

Deno.test("HotQueryRegistry: create + get", () => {
  const reg = new HotQueryRegistry({ maxSessions: 3, idleMs: 1000 });
  const s = makeFakeSession("a");
  reg.register(s);
  assertEquals(reg.get("a"), s);
  reg.closeAll("test");
});

Deno.test("HotQueryRegistry: LRU evicts least recently touched at cap", async () => {
  const evicted: string[] = [];
  const reg = new HotQueryRegistry({
    maxSessions: 2,
    idleMs: 10_000,
    onEvict: (sid, reason) => evicted.push(`${sid}:${reason}`),
  });
  const a = makeFakeSession("a");
  const b = makeFakeSession("b");
  const c = makeFakeSession("c");
  reg.register(a);
  await new Promise((r) => setTimeout(r, 2));
  reg.register(b);
  await new Promise((r) => setTimeout(r, 2));
  reg.touch("a"); // a is now most recent
  reg.register(c); // should evict b (oldest)
  assertEquals(evicted, ["b:lru"]);
  assertEquals(reg.get("b"), undefined);
  assertEquals(reg.get("a") !== undefined, true);
  assertEquals(reg.get("c") !== undefined, true);
  await reg.closeAll("test");
});

Deno.test("HotQueryRegistry: idle timer evicts after idleMs", async () => {
  const evicted: string[] = [];
  const reg = new HotQueryRegistry({
    maxSessions: 3,
    idleMs: 50,
    onEvict: (sid, reason) => evicted.push(`${sid}:${reason}`),
  });
  reg.register(makeFakeSession("a"));
  await new Promise((r) => setTimeout(r, 120));
  assertEquals(evicted, ["a:idle"]);
  assertEquals(reg.get("a"), undefined);
  await reg.closeAll("test");
});

Deno.test("HotQueryRegistry: touch resets idle timer", async () => {
  const evicted: string[] = [];
  const reg = new HotQueryRegistry({
    maxSessions: 3,
    idleMs: 80,
    onEvict: (sid, reason) => evicted.push(`${sid}:${reason}`),
  });
  reg.register(makeFakeSession("a"));
  await new Promise((r) => setTimeout(r, 40));
  reg.touch("a");
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(evicted, []); // still alive
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(evicted, ["a:idle"]);
  await reg.closeAll("test");
});

Deno.test("HotQueryRegistry: closeAll empties map", async () => {
  const reg = new HotQueryRegistry({ maxSessions: 3, idleMs: 10_000 });
  reg.register(makeFakeSession("a"));
  reg.register(makeFakeSession("b"));
  await reg.closeAll("test");
  assertEquals(reg.get("a"), undefined);
  assertEquals(reg.get("b"), undefined);
  assertEquals(reg.list().length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx deno test --allow-all --no-lock claude/hot-query-registry_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement HotQueryRegistry**

Write to `claude/hot-query-registry.ts`:

```ts
/** @module claude/hot-query-registry — sessionId → HotQuerySession with LRU + idle eviction. */
import type { HotQuerySession } from "./hot-query.ts";

export type EvictReason = "idle" | "lru" | "recreate" | "error" | "shutdown" | "manual";

export interface HotQueryRegistryConfig {
  maxSessions: number;
  idleMs: number;
  onEvict?: (sessionId: string, reason: EvictReason) => void;
}

export interface HotQuerySummary {
  sessionId: string;
  workDir: string;
  idleMs: number;
  model?: string;
}

export class HotQueryRegistry {
  private sessions = new Map<string, HotQuerySession>();
  private timers = new Map<string, number>();
  private lastTouched = new Map<string, number>();
  private config: HotQueryRegistryConfig;

  constructor(config: HotQueryRegistryConfig) {
    this.config = config;
  }

  get(sessionId: string): HotQuerySession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): HotQuerySummary[] {
    const now = Date.now();
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      workDir: s.workDir,
      idleMs: now - (this.lastTouched.get(s.sessionId) ?? s.lastActivityAt),
      model: s.boundOptions?.model,
    }));
  }

  register(session: HotQuerySession): void {
    if (this.sessions.size >= this.config.maxSessions) {
      this.evictLRU();
    }
    this.sessions.set(session.sessionId, session);
    this.lastTouched.set(session.sessionId, Date.now());
    this.scheduleIdle(session.sessionId);
  }

  touch(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.lastTouched.set(sessionId, Date.now());
    this.scheduleIdle(sessionId);
  }

  async close(sessionId: string, reason: EvictReason): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.lastTouched.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    await session.close(reason);
    this.config.onEvict?.(sessionId, reason);
  }

  async closeAll(reason: EvictReason): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.close(id, reason);
    }
  }

  private scheduleIdle(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.close(sessionId, "idle").catch(() => {});
    }, this.config.idleMs);
    this.timers.set(sessionId, timer);
  }

  private evictLRU(): void {
    let oldestId: string | undefined;
    let oldestT = Infinity;
    for (const [id, t] of this.lastTouched.entries()) {
      if (t < oldestT) {
        oldestT = t;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.close(oldestId, "lru").catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx deno test --allow-all --no-lock claude/hot-query-registry_test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add claude/hot-query-registry.ts claude/hot-query-registry_test.ts
git commit -m "feat: add HotQueryRegistry with LRU and idle eviction"
```

---

## Task 6: SDK-backed query factory

**Files:**
- Modify: `claude/hot-query.ts`

Provide the real `QueryFactory` that wires `buildQueryOptions` + SDK `claudeQuery()`. Kept in the same file as `HotQuerySession` so the caller imports one module.

- [ ] **Step 1: Add factory**

Append to `claude/hot-query.ts`:

```ts
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions } from "./client.ts";

/**
 * Build a QueryFactory that invokes the real SDK `claudeQuery`.
 * The returned factory is called once per HotQuerySession construction.
 */
export async function makeSdkQueryFactory(
  workDir: string,
  options: ClaudeModelOptions | undefined,
  sessionIdToResume: string | undefined,
  controller: AbortController,
): Promise<QueryFactory> {
  const built = await buildQueryOptions(workDir, options, sessionIdToResume, controller);
  return (inputIter) => {
    return claudeQuery({
      prompt: inputIter as AsyncIterable<never>, // SDK accepts AsyncIterable<SDKUserMessage>
      options: built.options,
    }) as unknown as QueryLike;
  };
}
```

Note: `QueryLike` is declared earlier in the file. The cast is acceptable because the SDK `Query` shape is a superset of `QueryLike`.

- [ ] **Step 2: Type check**

Run: `npx deno check claude/hot-query.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add claude/hot-query.ts
git commit -m "feat: add SDK-backed query factory for hot query"
```

---

## Task 7: HotQuery config loader

**Files:**
- Create: `claude/hot-query-config.ts`
- Create: `claude/hot-query-config_test.ts`

Encapsulate env var reads (`HOT_QUERY_ENABLED`, `HOT_QUERY_IDLE_MS`, `HOT_QUERY_MAX_SESSIONS`) in one testable function.

- [ ] **Step 1: Write failing tests**

Write to `claude/hot-query-config_test.ts`:

```ts
/** @module claude/hot-query-config_test — Tests for env-var config reading. */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { readHotQueryConfig } from "./hot-query-config.ts";

Deno.test("readHotQueryConfig: defaults when no env set", () => {
  const cfg = readHotQueryConfig(() => undefined);
  assertEquals(cfg.enabled, true);
  assertEquals(cfg.idleMs, 900_000);
  assertEquals(cfg.maxSessions, 3);
});

Deno.test("readHotQueryConfig: HOT_QUERY_ENABLED=false disables", () => {
  const env: Record<string, string> = { HOT_QUERY_ENABLED: "false" };
  const cfg = readHotQueryConfig((k) => env[k]);
  assertEquals(cfg.enabled, false);
});

Deno.test("readHotQueryConfig: custom idleMs and maxSessions", () => {
  const env: Record<string, string> = {
    HOT_QUERY_IDLE_MS: "60000",
    HOT_QUERY_MAX_SESSIONS: "5",
  };
  const cfg = readHotQueryConfig((k) => env[k]);
  assertEquals(cfg.idleMs, 60_000);
  assertEquals(cfg.maxSessions, 5);
});

Deno.test("readHotQueryConfig: invalid numbers fall back to defaults", () => {
  const env: Record<string, string> = {
    HOT_QUERY_IDLE_MS: "abc",
    HOT_QUERY_MAX_SESSIONS: "-1",
  };
  const cfg = readHotQueryConfig((k) => env[k]);
  assertEquals(cfg.idleMs, 900_000);
  assertEquals(cfg.maxSessions, 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx deno test --allow-all --no-lock claude/hot-query-config_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config**

Write to `claude/hot-query-config.ts`:

```ts
/** @module claude/hot-query-config — Env-var-driven config for the hot query feature. */

export interface HotQueryConfig {
  enabled: boolean;
  idleMs: number;
  maxSessions: number;
}

const DEFAULT_IDLE_MS = 900_000; // 15 min
const DEFAULT_MAX = 3;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function readHotQueryConfig(
  getEnv: (key: string) => string | undefined,
): HotQueryConfig {
  const enabledRaw = getEnv("HOT_QUERY_ENABLED");
  const enabled = enabledRaw === undefined ? true : enabledRaw.toLowerCase() !== "false";
  return {
    enabled,
    idleMs: parsePositiveInt(getEnv("HOT_QUERY_IDLE_MS"), DEFAULT_IDLE_MS),
    maxSessions: parsePositiveInt(getEnv("HOT_QUERY_MAX_SESSIONS"), DEFAULT_MAX),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx deno test --allow-all --no-lock claude/hot-query-config_test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add claude/hot-query-config.ts claude/hot-query-config_test.ts
git commit -m "feat: add HotQuery config loader with env-var defaults"
```

---

## Task 8: Wire HotQueryRegistry into bot bootstrap

**Files:**
- Modify: `index.ts`

Create the registry at startup, expose it to the thread-message handler, install eviction notifier that posts to the corresponding Discord thread.

- [ ] **Step 1: Read index.ts to confirm the insertion points**

Run: `grep -n "sendToClaudeCode\|sessionThreadManager\|setupSignalHandlers\|onThreadMessage" index.ts`
Expected: shows line numbers for each. Record the line number of `onThreadMessage: async (threadChannelId: string, content: string)` (currently ~311).

- [ ] **Step 2: Add imports and registry creation**

Near the top of `index.ts`, next to the existing claude imports, add:

```ts
import { readHotQueryConfig } from "./claude/hot-query-config.ts";
import { HotQueryRegistry } from "./claude/hot-query-registry.ts";
import { HotQuerySession, makeSdkQueryFactory } from "./claude/hot-query.ts";
```

After `workspaceManager` and `sessionThreadManager` are created (before `dependencies: BotDependencies = {`), add:

```ts
const hotQueryConfig = readHotQueryConfig((k) => Deno.env.get(k));
const hotQueryRegistry = new HotQueryRegistry({
  maxSessions: hotQueryConfig.maxSessions,
  idleMs: hotQueryConfig.idleMs,
  onEvict: (sessionId, reason) => {
    console.log(`[HotQuery] session=${sessionId} closed (reason: ${reason})`);
    if (reason === "lru") {
      const thread = sessionThreadManager.getThread(sessionId);
      thread?.send(
        "🧊 会话已进入休眠以释放资源，下一条消息将正常处理（首条会多等 2-3s 冷启动）",
      ).catch(() => {});
    }
  },
});
```

- [ ] **Step 3: Replace onThreadMessage body**

Locate the existing `onThreadMessage: async (threadChannelId: string, content: string) => { ... }` block in `index.ts` (currently ~line 311). Replace its body (everything between the outer `{ ... }`) with:

```ts
      const sessionId = sessionThreadManager.findSessionByThreadId(threadChannelId);
      if (!sessionId) {
        console.warn(`[ThreadMessage] No session found for thread ${threadChannelId}, ignoring`);
        return;
      }
      if (sessionId.startsWith("pending_") || sessionId.startsWith("failed_")) {
        console.warn(
          `[ThreadMessage] Session not ready (${sessionId.slice(0, 20)}…), ignoring message`,
        );
        return;
      }
      const thread = sessionThreadManager.getThread(sessionId);
      if (!thread) {
        console.warn(
          `[ThreadMessage] Thread channel not resolved for session ${sessionId}, cannot resume`,
        );
        return;
      }

      const thinkingMsg = await thread.send("`Claude is thinking...`");
      sessionThreadManager.recordActivity(sessionId);

      const { send: threadSender, setSessionId } = createClaudeSender(
        createChannelSenderAdapter(thread),
        { isThread: true, sessionId },
      );
      const controller = new AbortController();
      const threadKey = threadChannelId;
      claudeSessionOps.setController(controller, threadKey);

      const parentChannelId = (thread as any).parentId ?? threadChannelId;
      const effectiveWorkDir = workspaceManager.resolve(parentChannelId);
      const turnOptions = { appendSystemPrompt: BOT_SYSTEM_PROMPT };

      const onStreamJson = (jsonData: any) => {
        const claudeMessages = convertToClaudeMessages(jsonData);
        if (claudeMessages.length > 0) {
          threadSender(claudeMessages).catch(() => {});
        }
      };
      const onTyping = () => {
        try {
          thread.sendTyping();
        } catch { /* ignore */ }
      };

      try {
        if (hotQueryConfig.enabled) {
          let hot = hotQueryRegistry.get(sessionId);
          if (!hot) {
            console.log(`[HotQuery] session=${sessionId} creating (cold init)`);
            const t0 = Date.now();
            const factory = await makeSdkQueryFactory(
              effectiveWorkDir,
              turnOptions,
              sessionId,
              controller,
            );
            hot = HotQuerySession.create({
              sessionId,
              workDir: effectiveWorkDir,
              options: turnOptions,
              queryFactory: factory,
            });
            hotQueryRegistry.register(hot);
            console.log(`[HotQuery] session=${sessionId} created in ${Date.now() - t0}ms`);
          } else {
            console.log(`[HotQuery] session=${sessionId} reused (skip cold-init)`);
            hotQueryRegistry.touch(sessionId);
          }
          const result = await hot.runTurn(content, controller, {
            onStreamJson,
            onTyping,
          });
          if (result.sessionId) {
            claudeSessionOps.setSessionId(result.sessionId, threadKey);
            setSessionId(result.sessionId);
          }
        } else {
          const result = await sendToClaudeCode(
            effectiveWorkDir,
            content,
            controller,
            sessionId,
            undefined,
            onStreamJson,
            turnOptions,
            onTyping,
          );
          if (result.sessionId) {
            claudeSessionOps.setSessionId(result.sessionId, threadKey);
            setSessionId(result.sessionId);
          }
        }
      } catch (error) {
        console.error(`[ThreadMessage] Failed to resume session ${sessionId}:`, error);
        const errMsg = error instanceof Error ? error.message : String(error);
        await thread.send(`⚠️ Failed to resume session: ${errMsg}`).catch(() => {});
      } finally {
        claudeSessionOps.setController(null, threadKey);
        try {
          await thinkingMsg.delete();
        } catch { /* ignore */ }
      }
```

- [ ] **Step 4: Type check**

Run: `npx deno check index.ts`
Expected: no errors.

- [ ] **Step 5: Run full test suite**

Run: `npx deno task test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: route session thread messages through HotQueryRegistry"
```

---

## Task 9: Close hot queries on shutdown

**Files:**
- Modify: `core/signal-handler.ts`
- Modify: `index.ts`

- [ ] **Step 1: Extend CleanupContext**

In `core/signal-handler.ts`, update the `CleanupContext` interface and `createShutdownHandler` to call the new hook:

Replace the interface (around lines 11–22):

```ts
export interface CleanupContext {
  killAllShellProcesses: () => void;
  killAllWorktreeBots: () => void;
  getClaudeController: () => AbortController | null;
  closeHotQueries?: () => Promise<void>;
  sendShutdownNotification: (signal: string) => Promise<void>;
  destroyClient: () => void;
}
```

Inside `createShutdownHandler`, after the existing `claudeController.abort()` call and before `sendShutdownNotification`, add:

```ts
      if (ctx.closeHotQueries) {
        try {
          await ctx.closeHotQueries();
        } catch (err) {
          console.error("Error closing hot queries:", err);
        }
      }
```

- [ ] **Step 2: Wire up from index.ts**

In `index.ts`, locate the `setupSignalHandlers({ ... })` call and add the new field:

```ts
  closeHotQueries: () => hotQueryRegistry.closeAll("shutdown"),
```

- [ ] **Step 3: Type check**

Run: `npx deno check index.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add core/signal-handler.ts index.ts
git commit -m "feat: close hot queries on SIGINT/SIGTERM"
```

---

## Task 10: /hot-queries observability command

**Files:**
- Create: `claude/hot-query-command.ts`
- Modify: `core/handler-registry.ts` (register the new command)

Minimal read-only slash command that prints the registry's current state.

- [ ] **Step 1: Define the command**

Write to `claude/hot-query-command.ts`:

```ts
/** @module claude/hot-query-command — /hot-queries slash command. */
import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import type { HotQueryRegistry } from "./hot-query-registry.ts";

export const hotQueriesCommand = new SlashCommandBuilder()
  .setName("hot-queries")
  .setDescription("列出当前活跃的 hot query 会话");

export function createHotQueriesHandler(registry: HotQueryRegistry) {
  return {
    "hot-queries": async (interaction: {
      reply: (msg: { content: string; ephemeral?: boolean }) => Promise<unknown>;
    }) => {
      const rows = registry.list();
      if (rows.length === 0) {
        await interaction.reply({ content: "📭 没有活跃的 hot query。", ephemeral: true });
        return;
      }
      const lines = rows.map((r) =>
        `• session=\`${r.sessionId.slice(0, 8)}…\` idle=${Math.floor(r.idleMs / 1000)}s model=${
          r.model ?? "default"
        }`
      );
      await interaction.reply({
        content: ["🔥 活跃 hot queries:", ...lines].join("\n"),
        ephemeral: true,
      });
    },
  };
}
```

- [ ] **Step 2: Register in handler-registry.ts**

In `core/handler-registry.ts`, add import near the other claude imports:

```ts
import { createHotQueriesHandler, hotQueriesCommand } from "../claude/hot-query-command.ts";
```

Find where `getAllCommands()` aggregates commands and append `hotQueriesCommand` to the returned list. Find where command handlers are merged into a single record and merge in `createHotQueriesHandler(hotQueryRegistry)` — the registry instance must be passed through the bot-factory/deps chain. Simplest wire-up: expose the registry via a new parameter on the relevant creation function and thread it through.

  Concretely, if the bot-factory signature is `createHandlers(deps)` add `hotQueryRegistry` to `deps` and pass `hotQueryRegistry` from `index.ts` at construction time.

- [ ] **Step 3: Type check**

Run: `npx deno check index.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add claude/hot-query-command.ts core/handler-registry.ts index.ts
git commit -m "feat: add /hot-queries observability command"
```

---

## Task 11: Document env vars

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append to .env.example**

Append near the other optional env var section:

```bash
# ----- Hot Query (streaming-input mode) -----
# Keeps one long-running Query per session thread so 2nd+ messages skip cold start.
# HOT_QUERY_ENABLED=true
# HOT_QUERY_IDLE_MS=900000     # idle reclaim threshold (ms); default 15 min
# HOT_QUERY_MAX_SESSIONS=3     # max concurrent hot queries; LRU evicts at cap
```

- [ ] **Step 2: Add a note to CLAUDE.md**

In the `## Architecture` section of `CLAUDE.md`, in the `claude/` directory bullets, add:

```markdown
  - `hot-query.ts` — AsyncPushQueue + HotQuerySession for streaming-input mode
  - `hot-query-registry.ts` — LRU + idle eviction for hot queries
  - `hot-query-config.ts` — env-var driven config
  - `hot-query-command.ts` — /hot-queries slash command
```

And in the `## Important Patterns` section, add:

```markdown
- **Hot query reuse:** Session threads keep one long-lived SDK `Query` per sessionId (`claude/hot-query-registry.ts`). First message pays the 2-3s cold start; subsequent messages push prompts into a streaming input queue and skip init. Config via `HOT_QUERY_*` env vars. Disable entirely with `HOT_QUERY_ENABLED=false`.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document hot-query env vars and architecture"
```

---

## Task 12: Manual smoke test

**Files:** none

- [ ] **Step 1: Type check + format + lint + test**

Run:

```bash
npx deno task test && npx deno check index.ts && npx deno lint && npx deno fmt
```

Expected: all green.

- [ ] **Step 2: Launch bot in dev mode**

Run: `npx deno task dev`

- [ ] **Step 3: Exercise the hot path**

In a Discord session thread:
1. Send the first message — expect log `[HotQuery] session=... creating (cold init)` then `created in ~2500ms`.
2. Send a second message — expect log `[HotQuery] session=... reused (skip cold-init)` and noticeably faster response.
3. Run `/hot-queries` — verify the session appears with small `idle=` seconds.
4. Wait > `HOT_QUERY_IDLE_MS` (use a short override like `HOT_QUERY_IDLE_MS=10000` for the test) and verify the log `closed (reason: idle)`.

- [ ] **Step 4: Exercise LRU eviction**

Set `HOT_QUERY_MAX_SESSIONS=2`. Open 3 different session threads in sequence, each with one message. Verify:
1. The oldest thread gets a `🧊 会话已进入休眠...` notice.
2. Log shows `closed (reason: lru)` for that session.

- [ ] **Step 5: Exercise disabled mode**

Set `HOT_QUERY_ENABLED=false`, restart, verify all messages go through `sendToClaudeCode` (no `[HotQuery]` logs) and behavior is unchanged.

- [ ] **Step 6: Commit final docs if any changes**

If you fixed anything during smoke testing, commit with an appropriate message.

---

## Spec Coverage Checklist

- ✅ Hot query per session thread — Task 8
- ✅ AsyncPushQueue — Task 1
- ✅ Turn boundaries (result → resolve) — Task 4
- ✅ Concurrency policy (reject second turn) — Task 4
- ✅ Abort → interrupt, not close — Task 4
- ✅ reuse vs recreate decision — Task 3
- ✅ LRU + idle eviction — Task 5
- ✅ LRU eviction posts Discord notice — Task 8 (onEvict handler)
- ✅ Env vars HOT_QUERY_ENABLED / IDLE_MS / MAX_SESSIONS — Tasks 7, 11
- ✅ Shutdown closes hot queries — Task 9
- ✅ /hot-queries command — Task 10
- ✅ Logs for created / reused / closed — Tasks 5, 8





