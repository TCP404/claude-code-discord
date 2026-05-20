/** @module claude/queue_test — Tests for PromptQueue and mergePrompts. */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mergePrompts, PromptQueue, type QueuedMessage } from "./queue.ts";

function mk(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    prompt: "hello",
    messageId: "m1",
    channelId: "c1",
    userId: "u1",
    receivedAt: 1000,
    ...overrides,
  };
}

Deno.test("PromptQueue: enqueue accepts items up to maxSize", () => {
  const q = new PromptQueue(2);
  assertEquals(q.enqueue(mk({ messageId: "m1" })), true);
  assertEquals(q.enqueue(mk({ messageId: "m2" })), true);
  assertEquals(q.size(), 2);
});

Deno.test("PromptQueue: enqueue returns false when full", () => {
  const q = new PromptQueue(2);
  q.enqueue(mk({ messageId: "m1" }));
  q.enqueue(mk({ messageId: "m2" }));
  assertEquals(q.enqueue(mk({ messageId: "m3" })), false);
  assertEquals(q.size(), 2);
});

Deno.test("PromptQueue: drain returns all items in insertion order and empties queue", () => {
  const q = new PromptQueue(5);
  q.enqueue(mk({ messageId: "m1", receivedAt: 1 }));
  q.enqueue(mk({ messageId: "m2", receivedAt: 2 }));
  const out = q.drain();
  assertEquals(out.map((m) => m.messageId), ["m1", "m2"]);
  assertEquals(q.size(), 0);
});

Deno.test("PromptQueue: clearByUser removes only that user's items, preserves others", () => {
  const q = new PromptQueue(5);
  q.enqueue(mk({ messageId: "m1", userId: "alice" }));
  q.enqueue(mk({ messageId: "m2", userId: "bob" }));
  q.enqueue(mk({ messageId: "m3", userId: "alice" }));
  const cleared = q.clearByUser("alice");
  assertEquals(cleared.map((m) => m.messageId), ["m1", "m3"]);
  assertEquals(q.size(), 1);
  assertEquals(q.drain()[0].messageId, "m2");
});

Deno.test("PromptQueue: clearByUser returns empty array for unknown user", () => {
  const q = new PromptQueue(5);
  q.enqueue(mk({ messageId: "m1", userId: "alice" }));
  assertEquals(q.clearByUser("ghost"), []);
  assertEquals(q.size(), 1);
});

Deno.test("PromptQueue: items() returns a copy, not a live reference", () => {
  const q = new PromptQueue(5);
  q.enqueue(mk({ messageId: "m1" }));
  const snapshot = q.items();
  q.enqueue(mk({ messageId: "m2" }));
  assertEquals(snapshot.length, 1);
});

Deno.test("mergePrompts: empty array returns empty string", () => {
  assertEquals(mergePrompts([]), "");
});

Deno.test("mergePrompts: single item returns the prompt verbatim (no separator)", () => {
  assertEquals(mergePrompts([mk({ prompt: "only one" })]), "only one");
});

Deno.test("mergePrompts: multiple items joined with double newline", () => {
  const merged = mergePrompts([
    mk({ prompt: "first", receivedAt: 1 }),
    mk({ prompt: "second", receivedAt: 2 }),
    mk({ prompt: "third", receivedAt: 3 }),
  ]);
  assertEquals(merged, "first\n\nsecond\n\nthird");
});

Deno.test("mergePrompts: sorts by receivedAt ascending before joining", () => {
  const merged = mergePrompts([
    mk({ prompt: "B", receivedAt: 20 }),
    mk({ prompt: "A", receivedAt: 10 }),
    mk({ prompt: "C", receivedAt: 30 }),
  ]);
  assertEquals(merged, "A\n\nB\n\nC");
});
