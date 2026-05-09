/** @module claude/session-usage — Per-session cost and query count tracking. */

export interface SessionUsage {
  totalCost: number;
  totalDuration: number;
  queryCount: number;
}

const usageMap = new Map<string, SessionUsage>();

export function recordUsage(sessionId: string, cost: number, duration: number): SessionUsage {
  const existing = usageMap.get(sessionId);
  if (existing) {
    existing.totalCost += cost;
    existing.totalDuration += duration;
    existing.queryCount += 1;
    return existing;
  }
  const usage: SessionUsage = { totalCost: cost, totalDuration: duration, queryCount: 1 };
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
