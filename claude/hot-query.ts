/** @module claude/hot-query — AsyncPushQueue + HotQuerySession for streaming-input mode. */

import type { ClaudeModelOptions, SDKPermissionMode } from "./client.ts";

/**
 * An async iterable driven by external `push()` calls. Pending `.next()` promises
 * resolve as soon as an item is pushed. After `close()`, all pending and future
 * `.next()` calls resolve with `{ done: true }`.
 */
export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private pending: Array<(r: IteratorResult<T>) => void> = [];
  private buffer: T[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.pending.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.pending) {
      w({ value: undefined as unknown as T, done: true });
    }
    this.pending = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.pending.push(resolve));
      },
    };
  }
}

export type PrepareSetter =
  | { kind: "setModel"; value: string | undefined }
  | { kind: "setPermissionMode"; value: SDKPermissionMode };

export type PrepareResult =
  | { verdict: "reuse"; setters: PrepareSetter[] }
  | { verdict: "recreate"; reason: string };

const RECREATE_FIELDS: Array<keyof ClaudeModelOptions> = [
  "appendSystemPrompt",
  "agent",
  "agents",
  "betas",
  "sandbox",
  "thinking",
  "effort",
  "additionalDirectories",
  "enableFileCheckpointing",
];

// Array order matters. Fine here because options come from the same builder
// every turn, so arrays are produced in stable order.
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Decide whether an incoming turn's options can reuse an existing hot query
 * or require a full recreate.
 */
export function prepareForTurn(
  bound: ClaudeModelOptions | undefined,
  next: ClaudeModelOptions | undefined,
  boundCwd: string,
  nextCwd: string,
): PrepareResult {
  if (boundCwd !== nextCwd) {
    return { verdict: "recreate", reason: "cwd" };
  }
  for (const field of RECREATE_FIELDS) {
    if (!deepEqual(bound?.[field], next?.[field])) {
      return { verdict: "recreate", reason: String(field) };
    }
  }
  const setters: PrepareSetter[] = [];
  if (bound?.model !== next?.model) {
    setters.push({ kind: "setModel", value: next?.model });
  }
  if (bound?.permissionMode !== next?.permissionMode && next?.permissionMode) {
    setters.push({ kind: "setPermissionMode", value: next.permissionMode });
  }
  return { verdict: "reuse", setters };
}
