/** @module claude/hot-query — AsyncPushQueue + HotQuerySession for streaming-input mode. */

import { buildQueryOptions, extractPermissionDenials } from "./client.ts";
import type { ClaudeModelOptions } from "./client.ts";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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

export interface TurnCallbacks {
  onChunk?: (text: string) => void;
  onStreamJson?: (msg: any) => void;
  onTyping?: () => void;
}

export interface TurnResult {
  response: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  modelUsed?: string;
  permissionDenials?: Array<
    { toolName: string; toolUseId: string; toolInput: Record<string, unknown> }
  >;
}

interface ActiveTurn {
  controller: AbortController;
  callbacks: TurnCallbacks;
  response: string;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  abortListener: () => void;
  typingInterval?: ReturnType<typeof setInterval>;
}

// Discord's typing indicator auto-clears ~10s after the last trigger.
// 8s keeps it continuously visible while a turn is in flight.
const TYPING_REFRESH_MS = 8000;

// Minimal structural type for the SDK Query shape we use (keeps tests decoupled).
export interface QueryLike {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  interrupt(): Promise<void>;
  close(): void;
}

export type QueryFactory = (
  prompt: AsyncIterable<{
    type: "user";
    message: { role: "user"; content: string };
    parent_tool_use_id: null;
    session_id?: string;
  }>,
) => QueryLike;

export interface HotQueryCreateParams {
  sessionId: string;
  workDir: string;
  options: ClaudeModelOptions | undefined;
  queryFactory: QueryFactory;
}

export class HotQuerySession {
  readonly sessionId: string;
  readonly workDir: string;
  boundOptions: ClaudeModelOptions | undefined;
  lastActivityAt: number;

  private query: QueryLike;
  private inputQueue: AsyncPushQueue<{
    type: "user";
    message: { role: "user"; content: string };
    parent_tool_use_id: null;
    session_id?: string;
  }>;
  private currentTurn: ActiveTurn | null = null;
  private closed = false;
  private consumerPromise: Promise<void>;

  private constructor(params: HotQueryCreateParams) {
    this.sessionId = params.sessionId;
    this.workDir = params.workDir;
    this.boundOptions = params.options;
    this.lastActivityAt = Date.now();
    this.inputQueue = new AsyncPushQueue();
    this.query = params.queryFactory(this.inputQueue);
    this.consumerPromise = this.runConsumer();
  }

  static create(params: HotQueryCreateParams): HotQuerySession {
    return new HotQuerySession(params);
  }

  /** Whether a turn is currently in flight. */
  get busy(): boolean {
    return this.currentTurn !== null;
  }

  /** Interrupt the current turn gracefully without closing the session. */
  async interrupt(): Promise<boolean> {
    if (!this.currentTurn) return false;
    try {
      await this.query.interrupt();
      return true;
    } catch {
      return false;
    }
  }

  private async runConsumer(): Promise<void> {
    try {
      for await (const msg of this.query) {
        const turn = this.currentTurn;
        if (!turn) continue; // ignore messages outside a turn

        try {
          turn.callbacks.onStreamJson?.(msg);
        } catch { /* non-critical */ }

        if (
          msg.type === "assistant" &&
          "message" in msg &&
          (msg as any).message?.content
        ) {
          const text = ((msg as any).message.content as Array<any>)
            .filter((c) => c?.type === "text")
            .map((c) => c.text)
            .join("");
          if (text) {
            turn.response = text;
            try {
              turn.callbacks.onChunk?.(text);
            } catch { /* non-critical */ }
          }
        }

        if (msg.type === "result") {
          const r = msg as any;
          const denials = extractPermissionDenials([msg]);
          const resolved: TurnResult = {
            response: turn.response || "No response received",
            sessionId: r.session_id,
            cost: r.total_cost_usd,
            duration: r.duration_ms,
            modelUsed: this.boundOptions?.model || "Default",
            ...(denials.length > 0 && { permissionDenials: denials }),
          };
          this.endTurn(turn);
          turn.resolve(resolved);
        }
      }
    } catch (err) {
      const turn = this.currentTurn;
      if (turn) {
        this.endTurn(turn);
        turn.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private endTurn(turn: ActiveTurn): void {
    turn.controller.signal.removeEventListener("abort", turn.abortListener);
    if (turn.typingInterval !== undefined) clearInterval(turn.typingInterval);
    this.currentTurn = null;
  }

  runTurn(
    prompt: string,
    controller: AbortController,
    callbacks: TurnCallbacks,
  ): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error("HotQuerySession closed"));
    if (this.currentTurn) {
      return Promise.reject(new Error("Busy: previous turn still running"));
    }
    this.lastActivityAt = Date.now();

    return new Promise<TurnResult>((resolve, reject) => {
      const abortListener = () => {
        this.query.interrupt().catch(() => {});
      };
      controller.signal.addEventListener("abort", abortListener, { once: true });

      let typingInterval: ReturnType<typeof setInterval> | undefined;
      if (callbacks.onTyping) {
        try {
          callbacks.onTyping();
        } catch { /* non-critical */ }
        typingInterval = setInterval(() => {
          try {
            callbacks.onTyping!();
          } catch { /* non-critical */ }
        }, TYPING_REFRESH_MS);
      }

      this.currentTurn = {
        controller,
        callbacks,
        response: "",
        resolve,
        reject,
        abortListener,
        typingInterval,
      };
      this.inputQueue.push({
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
    });
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const turn = this.currentTurn;
    if (turn) {
      this.endTurn(turn);
      turn.reject(new Error(`HotQuerySession closed: ${reason}`));
    }
    this.inputQueue.close();
    try {
      this.query.close();
    } catch { /* ignore */ }
    await this.consumerPromise.catch(() => {});
  }
}

/**
 * Build a QueryFactory that invokes the real SDK `claudeQuery`.
 * The returned factory is called once per HotQuerySession construction.
 */
export async function makeSdkQueryFactory(
  workDir: string,
  options: ClaudeModelOptions | undefined,
  sessionIdToResume: string | undefined,
  controller: AbortController,
): Promise<QueryFactory> {
  const built = await buildQueryOptions(workDir, options, sessionIdToResume, controller);
  return (inputIter) => {
    return claudeQuery({
      prompt: inputIter as AsyncIterable<never>, // SDK accepts AsyncIterable<SDKUserMessage>
      abortController: built.abortController,
      options: built.options,
    } as any) as unknown as QueryLike;
  };
}
