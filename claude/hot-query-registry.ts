/** @module claude/hot-query-registry — sessionId → HotQuerySession with LRU + idle eviction. */
import type { HotQuerySession } from "./hot-query.ts";

export type EvictReason =
  | "idle"
  | "lru"
  | "recreate"
  | "error"
  | "shutdown"
  | "manual"
  // deno-lint-ignore ban-types
  | (string & {});

export interface HotQueryRegistryConfig {
  maxSessions: number;
  idleMs: number;
  onEvict?: (sessionId: string, reason: EvictReason) => void;
}

export interface HotQuerySummary {
  sessionId: string;
  workDir: string;
  idleMs: number;
  reuseCount: number;
  model?: string;
}

export interface HotQueryStats {
  createdTotal: number;
  reusedTotal: number;
}

export class HotQueryRegistry {
  private sessions = new Map<string, HotQuerySession>();
  private timers = new Map<string, number>();
  private lastTouched = new Map<string, number>();
  private reuseCounts = new Map<string, number>();
  private config: HotQueryRegistryConfig;
  private createdTotal = 0;
  private reusedTotal = 0;

  constructor(config: HotQueryRegistryConfig) {
    this.config = config;
  }

  get(sessionId: string): HotQuerySession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): HotQuerySummary[] {
    const now = Date.now();
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      workDir: s.workDir,
      idleMs: now - (this.lastTouched.get(s.sessionId) ?? s.lastActivityAt),
      reuseCount: this.reuseCounts.get(s.sessionId) ?? 0,
      model: s.boundOptions?.model,
    }));
  }

  stats(): HotQueryStats {
    return { createdTotal: this.createdTotal, reusedTotal: this.reusedTotal };
  }

  async register(session: HotQuerySession): Promise<void> {
    if (this.sessions.size >= this.config.maxSessions) {
      await this.evictLRU();
    }
    this.sessions.set(session.sessionId, session);
    this.lastTouched.set(session.sessionId, Date.now());
    this.reuseCounts.set(session.sessionId, 0);
    this.createdTotal++;
    this.scheduleIdle(session.sessionId);
  }

  getReuseCount(sessionId: string): number {
    return this.reuseCounts.get(sessionId) ?? 0;
  }

  /**
   * Bump activity timestamp + reset idle timer WITHOUT incrementing reuse
   * counters. Use this for any user-facing activity that prolongs session
   * life but isn't itself a "reuse" (e.g. queueing a follow-up message,
   * a turn just finishing).
   */
  bumpActivity(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.lastTouched.set(sessionId, Date.now());
    this.scheduleIdle(sessionId);
  }

  /**
   * Mark this session as reused: increment counters AND bump activity.
   * Call this exactly once per genuine "reuse event" — i.e. when a new
   * user message arrives and finds an already-warm session.
   */
  touch(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.lastTouched.set(sessionId, Date.now());
    this.reuseCounts.set(sessionId, (this.reuseCounts.get(sessionId) ?? 0) + 1);
    this.reusedTotal++;
    this.scheduleIdle(sessionId);
  }

  async close(sessionId: string, reason: EvictReason): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.lastTouched.delete(sessionId);
    this.reuseCounts.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    await session.close(reason);
    this.config.onEvict?.(sessionId, reason);
  }

  /** Interrupt any currently-busy hot query session. Returns true if one was interrupted. */
  async interruptBusy(): Promise<boolean> {
    for (const session of this.sessions.values()) {
      if (session.busy) {
        return session.interrupt();
      }
    }
    return false;
  }

  async closeAll(reason: EvictReason): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.close(id, reason);
    }
  }

  private scheduleIdle(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (session?.busy) {
        this.scheduleIdle(sessionId);
        return;
      }
      if (session && session.pendingQueue.size() > 0) {
        // Queued messages are waiting to be processed; defer eviction.
        this.scheduleIdle(sessionId);
        return;
      }
      this.close(sessionId, "idle").catch((err) => {
        console.error(`[HotQueryRegistry] idle close failed for ${sessionId}:`, err);
      });
    }, this.config.idleMs);
    this.timers.set(sessionId, timer);
  }

  private async evictLRU(): Promise<void> {
    // Pick the oldest session that is NOT busy and has NO pending queue.
    // Killing a busy session aborts its in-flight turn (HotQuerySession
    // closed: lru); killing one with pending messages drops them silently.
    // Either is much worse UX than letting the cap creep over briefly,
    // so we skip such sessions and pick the next oldest. Only if every
    // session is busy/queued do we fall back to the absolute LRU as a
    // last resort.
    let evictableId: string | undefined;
    let evictableT = Infinity;
    let absoluteId: string | undefined;
    let absoluteT = Infinity;
    for (const [id, t] of this.lastTouched.entries()) {
      if (t < absoluteT) {
        absoluteT = t;
        absoluteId = id;
      }
      const session = this.sessions.get(id);
      if (!session) continue;
      if (session.busy) continue;
      if (session.pendingQueue.size() > 0) continue;
      if (t < evictableT) {
        evictableT = t;
        evictableId = id;
      }
    }
    const target = evictableId ?? absoluteId;
    if (target) {
      if (!evictableId && absoluteId) {
        console.warn(
          `[HotQueryRegistry] LRU eviction forced on busy/queued session ${absoluteId} (no idle session available)`,
        );
      }
      try {
        await this.close(target, "lru");
      } catch (err) {
        console.error(`[HotQueryRegistry] LRU close failed for ${target}:`, err);
      }
    }
  }
}
