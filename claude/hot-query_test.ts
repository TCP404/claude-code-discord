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
