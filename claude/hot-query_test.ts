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
  if (result.verdict === "reuse") assertEquals(result.setters, []);
});

Deno.test("prepareForTurn: model change → reuse with setModel", () => {
  const next: ClaudeModelOptions = { ...base, model: "opus" };
  const result = prepareForTurn(base, next, "/work/dir", "/work/dir");
  assertEquals(result.verdict, "reuse");
  if (result.verdict === "reuse") {
    assertEquals(result.setters, [{ kind: "setModel", value: "opus" }]);
  }
});

Deno.test("prepareForTurn: permissionMode change → reuse with setPermissionMode", () => {
  const next: ClaudeModelOptions = { ...base, permissionMode: "plan" };
  const result = prepareForTurn(base, next, "/work/dir", "/work/dir");
  assertEquals(result.verdict, "reuse");
  if (result.verdict === "reuse") {
    assertEquals(result.setters, [{ kind: "setPermissionMode", value: "plan" }]);
  }
});

Deno.test("prepareForTurn: cwd change → recreate", () => {
  const result = prepareForTurn(base, base, "/old", "/new");
  assertEquals(result.verdict, "recreate");
  if (result.verdict === "recreate") assertEquals(result.reason, "cwd");
});

Deno.test("prepareForTurn: appendSystemPrompt change → recreate", () => {
  const next: ClaudeModelOptions = { ...base, appendSystemPrompt: "different" };
  const result = prepareForTurn(base, next, "/w", "/w");
  assertEquals(result.verdict, "recreate");
  if (result.verdict === "recreate") assertEquals(result.reason, "appendSystemPrompt");
});

Deno.test("prepareForTurn: thinking change → recreate", () => {
  const next: ClaudeModelOptions = { ...base, thinking: { type: "disabled" } };
  const result = prepareForTurn(base, next, "/w", "/w");
  assertEquals(result.verdict, "recreate");
  if (result.verdict === "recreate") assertEquals(result.reason, "thinking");
});

Deno.test("prepareForTurn: both model and permissionMode changed → reuse with two setters", () => {
  const next: ClaudeModelOptions = { ...base, model: "haiku", permissionMode: "plan" };
  const result = prepareForTurn(base, next, "/w", "/w");
  assertEquals(result.verdict, "reuse");
  if (result.verdict === "reuse") assertEquals(result.setters.length, 2);
});
