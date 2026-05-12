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
      this.close(sessionId, "idle").catch((err) => {
        console.error(`[HotQueryRegistry] idle close failed for ${sessionId}:`, err);
      });
    }, this.config.idleMs);
    this.timers.set(sessionId, timer);
  }

  private async evictLRU(): Promise<void> {
    let oldestId: string | undefined;
    let oldestT = Infinity;
    for (const [id, t] of this.lastTouched.entries()) {
      if (t < oldestT) {
        oldestT = t;
        oldestId = id;
      }
    }
    if (oldestId) {
      try {
        await this.close(oldestId, "lru");
      } catch (err) {
        console.error(`[HotQueryRegistry] LRU close failed for ${oldestId}:`, err);
      }
    }
  }
}
