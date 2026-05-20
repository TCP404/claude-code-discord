/** @module claude/active-senders — Registry mapping sessionId → currently active ClaudeSender. */

/**
 * The status line is owned by the per-turn `createClaudeSender()` closure. Enqueue and
 * clear-queue paths need to refresh the status line from outside that closure; this
 * registry is the bridge.
 *
 * Lifecycle: populated immediately before `runTurn`, cleared in the matching `finally`.
 */

export interface QueueAwareSender {
  /** Re-render the current status line, picking up the latest pendingQueue.size(). */
  refreshQueueStatus(): Promise<void>;
  /** Update the queue context that drives the status line's queue row + button. */
  setQueueContext(ctx: { count: number; sessionId: string } | null): void;
}

const senders = new Map<string, QueueAwareSender>();

export function setActiveSender(sessionId: string, sender: QueueAwareSender): void {
  senders.set(sessionId, sender);
}

export function clearActiveSender(sessionId: string, expected?: QueueAwareSender): void {
  if (expected !== undefined && senders.get(sessionId) !== expected) return;
  senders.delete(sessionId);
}

export function getActiveSender(sessionId: string): QueueAwareSender | undefined {
  return senders.get(sessionId);
}

/** Test helper: drop everything. Production code never calls this. */
export function _resetActiveSendersForTest(): void {
  senders.clear();
}
