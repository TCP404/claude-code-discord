/** @module claude/queue — PromptQueue and mergePrompts for hot-query message queueing. */

export interface QueuedMessage {
  /** User-typed prompt content. */
  prompt: string;
  /** Discord message ID — used to add/remove reactions. */
  messageId: string;
  /** Discord channel (thread) ID — needed for reaction API calls. */
  channelId: string;
  /** Discord user ID — used by clearByUser permission filter. */
  userId: string;
  /** Unix timestamp in ms when the message was received. */
  receivedAt: number;
}

/**
 * Bounded FIFO queue of pending user prompts.
 * Pure data structure; no Discord/SDK side effects.
 */
export class PromptQueue {
  private queue: QueuedMessage[] = [];
  readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /** Returns true when the message was enqueued, false when the queue is full. */
  enqueue(m: QueuedMessage): boolean {
    if (this.queue.length >= this.maxSize) return false;
    this.queue.push(m);
    return true;
  }

  /** Atomically remove and return all queued messages. */
  drain(): QueuedMessage[] {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  /** Remove and return only the messages whose userId matches. Others stay in place. */
  clearByUser(userId: string): QueuedMessage[] {
    const removed: QueuedMessage[] = [];
    const kept: QueuedMessage[] = [];
    for (const m of this.queue) {
      if (m.userId === userId) removed.push(m);
      else kept.push(m);
    }
    this.queue = kept;
    return removed;
  }

  /** Number of queued items. */
  size(): number {
    return this.queue.length;
  }

  /** Snapshot of current items (defensive copy). */
  items(): QueuedMessage[] {
    return this.queue.slice();
  }
}

/**
 * Merge queued prompts into a single string, sorted by receivedAt ascending,
 * joined with `\n\n`. Empty array → empty string. Single item → its prompt verbatim.
 */
export function mergePrompts(items: QueuedMessage[]): string {
  if (items.length === 0) return "";
  const sorted = items.slice().sort((a, b) => a.receivedAt - b.receivedAt);
  return sorted.map((m) => m.prompt).join("\n\n");
}
