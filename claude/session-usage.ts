/** @module claude/session-usage — Per-session cost and query count tracking. */

export interface SessionUsage {
  totalCost: number;
  totalDuration: number;
  queryCount: number;
  /** Cost delta for the most recent turn (set by recordUsage). */
  lastTurnCost: number;
  /** Duration delta for the most recent turn (set by recordUsage). */
  lastTurnDuration: number;
}

const usageMap = new Map<string, SessionUsage>();

/**
 * Record usage for a session turn.
 *
 * @param cumulative - When true, `cost` and `duration` are running totals from
 *   the SDK (hot-query mode). The per-turn delta is computed internally.
 *   When false (default), `cost` and `duration` are per-turn increments.
 */
export function recordUsage(
  sessionId: string,
  cost: number,
  duration: number,
  cumulative = false,
): SessionUsage {
  const existing = usageMap.get(sessionId);
  if (existing) {
    if (cumulative) {
      existing.lastTurnCost = Math.max(0, cost - existing.totalCost);
      existing.lastTurnDuration = Math.max(0, duration - existing.totalDuration);
      existing.totalCost = cost;
      existing.totalDuration = duration;
    } else {
      existing.lastTurnCost = cost;
      existing.lastTurnDuration = duration;
      existing.totalCost += cost;
      existing.totalDuration += duration;
    }
    existing.queryCount += 1;
    return existing;
  }
  const usage: SessionUsage = {
    totalCost: cost,
    totalDuration: duration,
    queryCount: 1,
    lastTurnCost: cost,
    lastTurnDuration: duration,
  };
  usageMap.set(sessionId, usage);
  return usage;
}

export function getUsage(sessionId: string): SessionUsage | undefined {
  return usageMap.get(sessionId);
}

export function clearUsage(sessionId: string): void {
  usageMap.delete(sessionId);
}

export function clearAllUsage(): void {
  usageMap.clear();
}
