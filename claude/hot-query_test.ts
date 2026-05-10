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

import { HotQuerySession } from "./hot-query.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Fake Query factory — captures pushed prompts, yields scripted messages.
function makeFakeQuery(scripted: SDKMessage[][]) {
  let turnIdx = 0;
  const pushedPrompts: string[] = [];
  const outQueue: AsyncPushQueue<SDKMessage> = new AsyncPushQueue<SDKMessage>();

  const query = {
    pushedPrompts,
    [Symbol.asyncIterator]: () => outQueue[Symbol.asyncIterator](),
    interrupt: () => Promise.resolve(),
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

Deno.test("HotQuerySession: result.permission_denials populates TurnResult.permissionDenials", async () => {
  const result = {
    type: "result",
    session_id: "sess-d",
    subtype: "success",
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm -rf /" } },
      { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "other" } }, // dedup by name
      { tool_name: "WebFetch", tool_use_id: "t3", tool_input: { url: "http://x" } },
    ],
  } as unknown as SDKMessage;
  const { factory } = makeFakeQuery([[result]]);
  const session = HotQuerySession.create({
    sessionId: "sess-d",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  const turn = await session.runTurn("q", new AbortController(), {});
  assertEquals(turn.permissionDenials?.length, 2);
  assertEquals(turn.permissionDenials?.[0].toolName, "Bash");
  assertEquals(turn.permissionDenials?.[1].toolName, "WebFetch");
  await session.close("test");
});

Deno.test("HotQuerySession: no denials → permissionDenials field omitted", async () => {
  const result = { type: "result", session_id: "sess-nd" } as unknown as SDKMessage;
  const { factory } = makeFakeQuery([[result]]);
  const session = HotQuerySession.create({
    sessionId: "sess-nd",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  const turn = await session.runTurn("q", new AbortController(), {});
  assertEquals(turn.permissionDenials, undefined);
  await session.close("test");
});

Deno.test("HotQuerySession: onTyping fires immediately on turn start", async () => {
  const done = { type: "result", session_id: "sess-t" } as unknown as SDKMessage;
  const { factory } = makeFakeQuery([[done]]);
  const session = HotQuerySession.create({
    sessionId: "sess-t",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  let typingCalls = 0;
  await session.runTurn("q", new AbortController(), {
    onTyping: () => typingCalls++,
  });
  assertEquals(typingCalls >= 1, true);
  await session.close("test");
});

Deno.test("HotQuerySession: close during in-flight turn rejects the turn promise", async () => {
  const { factory } = makeFakeQuery([[]]); // no result yielded → turn stays in-flight
  const session = HotQuerySession.create({
    sessionId: "sess-close",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  const pending = session.runTurn("hello", new AbortController(), {});
  await assertRejects(
    async () => {
      const p = pending;
      await session.close("shutdown");
      await p;
    },
    Error,
    "HotQuerySession closed: shutdown",
  );
});

Deno.test("HotQuerySession: runTurn after close rejects immediately", async () => {
  const { factory } = makeFakeQuery([[]]);
  const session = HotQuerySession.create({
    sessionId: "sess-after-close",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
  });
  await session.close("shutdown");
  await assertRejects(
    () => session.runTurn("hi", new AbortController(), {}),
    Error,
    "HotQuerySession closed",
  );
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
