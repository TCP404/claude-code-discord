/** @module claude/hot-query-registry_test — Tests for HotQueryRegistry. */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { HotQueryRegistry } from "./hot-query-registry.ts";
import { AsyncPushQueue, HotQuerySession } from "./hot-query.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Factory that returns a query which never yields a result message on its own.
// `close()` terminates the underlying AsyncPushQueue so the consumer loop exits
// cleanly (avoids leaked pending promises).
function makeFakeSession(sessionId: string): HotQuerySession {
  const outQueue = new AsyncPushQueue<SDKMessage>();
  const factory = () => ({
    [Symbol.asyncIterator]: () => outQueue[Symbol.asyncIterator](),
    interrupt: () => Promise.resolve(),
    close: () => outQueue.close(),
  });
  return HotQuerySession.create({
    sessionId,
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
}

Deno.test("HotQueryRegistry: create + get", async () => {
  const reg = new HotQueryRegistry({ maxSessions: 3, idleMs: 1000 });
  const s = makeFakeSession("a");
  await reg.register(s);
  assertEquals(reg.get("a"), s);
  await reg.closeAll("test");
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
  await reg.register(a);
  await new Promise((r) => setTimeout(r, 2));
  await reg.register(b);
  await new Promise((r) => setTimeout(r, 2));
  reg.touch("a"); // a is now most recent
  await reg.register(c); // awaits LRU close → onEvict fires before return
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
  await reg.register(makeFakeSession("a"));
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
  await reg.register(makeFakeSession("a"));
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
  await reg.register(makeFakeSession("a"));
  await reg.register(makeFakeSession("b"));
  await reg.closeAll("test");
  assertEquals(reg.get("a"), undefined);
  assertEquals(reg.get("b"), undefined);
  assertEquals(reg.list().length, 0);
});

Deno.test("HotQueryRegistry: closeAll propagates shutdown reason to onEvict", async () => {
  const evicted: string[] = [];
  const reg = new HotQueryRegistry({
    maxSessions: 3,
    idleMs: 10_000,
    onEvict: (sid, reason) => evicted.push(`${sid}:${reason}`),
  });
  await reg.register(makeFakeSession("a"));
  await reg.register(makeFakeSession("b"));
  await reg.closeAll("shutdown");
  assertEquals(evicted.sort(), ["a:shutdown", "b:shutdown"]);
});

Deno.test("HotQueryRegistry: interruptBusy interrupts active session", async () => {
  const reg = new HotQueryRegistry({ maxSessions: 3, idleMs: 10_000 });
  const s = makeFakeSession("busy");
  await reg.register(s);
  // Start a turn that won't auto-finish (no result message from fake)
  const pending = s.runTurn("hello", new AbortController(), {});
  assertEquals(s.busy, true);
  const result = await reg.interruptBusy();
  assertEquals(result, true);
  await reg.closeAll("test");
  await pending.catch(() => {});
});

Deno.test("HotQueryRegistry: interruptBusy returns false when no session is busy", async () => {
  const reg = new HotQueryRegistry({ maxSessions: 3, idleMs: 10_000 });
  await reg.register(makeFakeSession("idle"));
  const result = await reg.interruptBusy();
  assertEquals(result, false);
  await reg.closeAll("test");
});

Deno.test("HotQueryRegistry: stats tracks created and reused counts", async () => {
  const reg = new HotQueryRegistry({ maxSessions: 3, idleMs: 10_000 });
  await reg.register(makeFakeSession("a"));
  await reg.register(makeFakeSession("b"));
  reg.touch("a");
  reg.touch("a");
  reg.touch("b");
  assertEquals(reg.stats(), { createdTotal: 2, reusedTotal: 3 });
  const summary = reg.list().find((r) => r.sessionId === "a");
  assertEquals(summary?.reuseCount, 2);
  await reg.closeAll("test");
});
