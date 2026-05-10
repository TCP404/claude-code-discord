/** @module claude/hot-query-registry_test — Tests for HotQueryRegistry. */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { HotQueryRegistry } from "./hot-query-registry.ts";
import { AsyncPushQueue, HotQuerySession } from "./hot-query.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Factory that returns a query which never yields a result message on its own.
// `close()` terminates the underlying AsyncPushQueue so the consumer loop exits
// cleanly — matching the Task 4 test pattern (avoids leaked pending promises).
function makeFakeSession(sessionId: string): HotQuerySession {
  const outQueue = new AsyncPushQueue<SDKMessage>();
  const factory = () => ({
    [Symbol.asyncIterator]: () => outQueue[Symbol.asyncIterator](),
    interrupt: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    setPermissionMode: () => Promise.resolve(),
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
  reg.register(s);
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
  reg.register(a);
  await new Promise((r) => setTimeout(r, 2));
  reg.register(b);
  await new Promise((r) => setTimeout(r, 2));
  reg.touch("a"); // a is now most recent
  reg.register(c); // should evict b (oldest)
  // Wait for the async close to complete so onEvict fires
  await new Promise((r) => setTimeout(r, 10));
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
