/**
 * @module claude/queue-consumer — Single-caller consumer that drains the
 * pendingQueue and runs merged turns one at a time.
 *
 * Architectural rationale: previously two code paths called `runTurn`
 * (onThreadMessage normal-path and a drain loop fired by onTurnEnd). They
 * raced on the busy check and produced "Busy: previous turn still running"
 * errors. The fix is a single-caller pattern: every user message goes into
 * the queue first, and a per-session consumer is the *only* code path that
 * calls `runTurn`. The consumer is idempotent on `kick()` — concurrent
 * enqueues just join the existing run.
 */
import type { ThreadChannel } from "npm:discord.js@14.14.1";

import type { HotQuerySession } from "./hot-query.ts";
import type { QueueAwareSender } from "./active-senders.ts";
import { mergePrompts, type QueuedMessage } from "./queue.ts";
import { markProcessing, unmarkAll } from "../discord/queue-reactions.ts";

export interface QueueConsumerDeps {
  hot: HotQuerySession;
  thread: ThreadChannel;
  sessionId: string;
  /**
   * Build a fresh sender + the wired callbacks for one merged turn. Called
   * once per processed batch. The returned `cleanup` is invoked in the
   * matching `finally`, regardless of success.
   */
  buildSender: () => {
    senderApi: QueueAwareSender & { setSessionId: (id: string) => void };
    onStreamJson: (jsonData: unknown) => void;
    onTyping: () => void;
    cleanup: () => void;
  };
  setController?: (controller: AbortController | null) => void;
  onSessionIdResolved?: (sessionId: string) => void;
}

/**
 * Per-session consumer. Owns the only call site of `hot.runTurn`.
 */
export class QueueConsumer {
  private running = false;

  constructor(private deps: QueueConsumerDeps) {}

  /**
   * Idempotent: starts the consume loop if not already running.
   * Safe to call from concurrent enqueues — they all just observe
   * `running === true` and return.
   */
  kick(): void {
    if (this.running) return;
    this.running = true;
    this.loop().catch((err) => {
      console.error(
        `[QueueConsumer] loop crashed for ${this.deps.sessionId}:`,
        err,
      );
    }).finally(() => {
      this.running = false;
    });
  }

  private async loop(): Promise<void> {
    // The double-checked exit protects against this race:
    //   1. consumer drains queue and processes → queue empty
    //   2. consumer about to set running=false
    //   3. another message arrives, kick() sees running=true, returns
    //   4. consumer sets running=false, exits → message stranded
    // Solution: after the inner loop exits, recheck size before stopping.
    while (true) {
      while (this.deps.hot.pendingQueue.size() > 0) {
        await this.processOnce();
      }
      // Tentative exit. If anything raced in, run another pass.
      if (this.deps.hot.pendingQueue.size() === 0) return;
    }
  }

  private async processOnce(): Promise<void> {
    const pending: QueuedMessage[] = this.deps.hot.pendingQueue.drain();
    if (pending.length === 0) return;

    const { senderApi, onStreamJson, onTyping, cleanup } = this.deps
      .buildSender();

    // Status line: queue is empty now (we just drained). Future enqueues
    // during this turn will repopulate the badge via setQueueContext +
    // refreshQueueStatus.
    senderApi.setQueueContext(null);

    // ⏳ → ▶️ on each pending message
    for (const m of pending) {
      await markProcessing(this.deps.thread, m.messageId);
    }

    const merged = mergePrompts(pending);
    const controller = new AbortController();
    this.deps.setController?.(controller);

    try {
      const result = await this.deps.hot.runTurn(
        merged,
        controller,
        { onStreamJson, onTyping },
      );
      if (result.sessionId) {
        senderApi.setSessionId(result.sessionId);
        this.deps.onSessionIdResolved?.(result.sessionId);
      }
    } catch (err) {
      console.error(
        `[QueueConsumer] turn failed for ${this.deps.sessionId}:`,
        err,
      );
      try {
        await this.deps.thread.send(
          `⚠️ Failed to process message${pending.length > 1 ? "s" : ""}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch { /* ignore */ }
    } finally {
      this.deps.setController?.(null);
      for (const m of pending) {
        await unmarkAll(this.deps.thread, m.messageId);
      }
      cleanup();
    }
  }
}
