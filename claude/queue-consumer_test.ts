/** @module claude/queue-consumer_test — Tests for QueueConsumer. */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncPushQueue, HotQuerySession } from "./hot-query.ts";
import { QueueConsumer } from "./queue-consumer.ts";

/** Build a fake SDK query that emits scripted messages per turn. */
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

interface BuildSenderTracker {
  buildCount: number;
  cleanupCount: number;
}

function makeStubBuildSender(tracker: BuildSenderTracker) {
  return () => {
    tracker.buildCount++;
    return {
      senderApi: {
        refreshQueueStatus: () => Promise.resolve(),
        setQueueContext: () => {},
        setSessionId: () => {},
      },
      onStreamJson: () => {},
      onTyping: () => {},
      cleanup: () => {
        tracker.cleanupCount++;
      },
    };
  };
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

Deno.test("QueueConsumer: kick triggers a turn that drains pending and merges prompts", async () => {
  const result = { type: "result", session_id: "s1" } as unknown as SDKMessage;
  const { factory, query } = makeFakeQuery([[result]]);
  const session = HotQuerySession.create({
    sessionId: "s1",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
    queueMax: 10,
  });
  // Mock thread — only the methods QueueConsumer calls are needed.
  const thread = {
    send: () => Promise.resolve({} as never),
    sendTyping: () => Promise.resolve(),
    messages: { fetch: () => Promise.reject(new Error("not used")) },
  } as unknown as import("npm:discord.js@14.14.1").ThreadChannel;

  const tracker: BuildSenderTracker = { buildCount: 0, cleanupCount: 0 };
  const consumer = new QueueConsumer({
    hot: session,
    thread,
    sessionId: "s1",
    buildSender: makeStubBuildSender(tracker),
  });

  session.pendingQueue.enqueue({
    prompt: "first",
    messageId: "m1",
    channelId: "c1",
    userId: "u1",
    receivedAt: 1,
  });
  session.pendingQueue.enqueue({
    prompt: "second",
    messageId: "m2",
    channelId: "c1",
    userId: "u1",
    receivedAt: 2,
  });

  consumer.kick();
  await flushMicrotasks(5);

  // Both prompts should have been merged into a single SDK push.
  assertEquals((query as any).pushedPrompts.length, 1);
  assertEquals((query as any).pushedPrompts[0], "first\n\nsecond");
  assertEquals(session.pendingQueue.size(), 0);
  assertEquals(tracker.buildCount, 1);
  assertEquals(tracker.cleanupCount, 1);

  await session.close("test");
});

Deno.test("QueueConsumer: concurrent kicks coalesce — only one consume loop runs", async () => {
  const result = { type: "result", session_id: "s2" } as unknown as SDKMessage;
  const { factory, query } = makeFakeQuery([[result], [result]]);
  const session = HotQuerySession.create({
    sessionId: "s2",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
    queueMax: 10,
  });
  const thread = {
    send: () => Promise.resolve({} as never),
    sendTyping: () => Promise.resolve(),
    messages: { fetch: () => Promise.reject(new Error("not used")) },
  } as unknown as import("npm:discord.js@14.14.1").ThreadChannel;

  const tracker: BuildSenderTracker = { buildCount: 0, cleanupCount: 0 };
  const consumer = new QueueConsumer({
    hot: session,
    thread,
    sessionId: "s2",
    buildSender: makeStubBuildSender(tracker),
  });

  session.pendingQueue.enqueue({
    prompt: "p1",
    messageId: "m1",
    channelId: "c1",
    userId: "u1",
    receivedAt: 1,
  });

  // Three concurrent kicks should not produce three turns.
  consumer.kick();
  consumer.kick();
  consumer.kick();
  await flushMicrotasks(5);

  assertEquals((query as any).pushedPrompts.length, 1);
  assertEquals(tracker.buildCount, 1);

  await session.close("test");
});

Deno.test("QueueConsumer: messages enqueued during a turn are picked up by the same loop", async () => {
  const result1 = { type: "result", session_id: "s3" } as unknown as SDKMessage;
  const result2 = { type: "result", session_id: "s3" } as unknown as SDKMessage;
  const { factory, query } = makeFakeQuery([[result1], [result2]]);
  const session = HotQuerySession.create({
    sessionId: "s3",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
    queueMax: 10,
  });
  const thread = {
    send: () => Promise.resolve({} as never),
    sendTyping: () => Promise.resolve(),
    messages: { fetch: () => Promise.reject(new Error("not used")) },
  } as unknown as import("npm:discord.js@14.14.1").ThreadChannel;

  const tracker: BuildSenderTracker = { buildCount: 0, cleanupCount: 0 };
  const consumer = new QueueConsumer({
    hot: session,
    thread,
    sessionId: "s3",
    buildSender: () => {
      tracker.buildCount++;
      // On the FIRST build (i.e. just before runTurn), enqueue another message.
      // This simulates a user message arriving mid-turn.
      if (tracker.buildCount === 1) {
        queueMicrotask(() => {
          session.pendingQueue.enqueue({
            prompt: "midstream",
            messageId: "m2",
            channelId: "c1",
            userId: "u1",
            receivedAt: 99,
          });
        });
      }
      return {
        senderApi: {
          refreshQueueStatus: () => Promise.resolve(),
          setQueueContext: () => {},
          setSessionId: () => {},
        },
        onStreamJson: () => {},
        onTyping: () => {},
        cleanup: () => {
          tracker.cleanupCount++;
        },
      };
    },
  });

  session.pendingQueue.enqueue({
    prompt: "first",
    messageId: "m1",
    channelId: "c1",
    userId: "u1",
    receivedAt: 1,
  });

  consumer.kick();
  await flushMicrotasks(10);

  // The mid-stream enqueue should have been picked up by the same consumer
  // loop, producing exactly two SDK pushes.
  assertEquals((query as any).pushedPrompts.length, 2);
  assertEquals((query as any).pushedPrompts[0], "first");
  assertEquals((query as any).pushedPrompts[1], "midstream");
  assertEquals(tracker.buildCount, 2);
  assertEquals(tracker.cleanupCount, 2);

  await session.close("test");
});

Deno.test("QueueConsumer: idle kick (empty queue) is a no-op", async () => {
  const { factory, query } = makeFakeQuery([]);
  const session = HotQuerySession.create({
    sessionId: "s4",
    workDir: "/tmp",
    options: {},
    queryFactory: factory,
    queueMax: 10,
  });
  const thread = {
    send: () => Promise.resolve({} as never),
    sendTyping: () => Promise.resolve(),
    messages: { fetch: () => Promise.reject(new Error("not used")) },
  } as unknown as import("npm:discord.js@14.14.1").ThreadChannel;

  const tracker: BuildSenderTracker = { buildCount: 0, cleanupCount: 0 };
  const consumer = new QueueConsumer({
    hot: session,
    thread,
    sessionId: "s4",
    buildSender: makeStubBuildSender(tracker),
  });

  consumer.kick();
  await flushMicrotasks(3);

  assertEquals((query as any).pushedPrompts.length, 0);
  assertEquals(tracker.buildCount, 0);

  await session.close("test");
});
