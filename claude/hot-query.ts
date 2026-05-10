/** @module claude/hot-query — AsyncPushQueue + HotQuerySession for streaming-input mode. */

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
