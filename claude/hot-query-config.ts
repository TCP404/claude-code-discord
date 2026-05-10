/** @module claude/hot-query-config — Env-var-driven config for the hot query feature. */

export interface HotQueryConfig {
  enabled: boolean;
  idleMs: number;
  maxSessions: number;
}

const DEFAULT_IDLE_MS = 900_000; // 15 min
const DEFAULT_MAX = 3;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function readHotQueryConfig(
  getEnv: (key: string) => string | undefined,
): HotQueryConfig {
  const enabledRaw = getEnv("HOT_QUERY_ENABLED");
  const enabled = enabledRaw === undefined ? true : enabledRaw.toLowerCase() !== "false";
  return {
    enabled,
    idleMs: parsePositiveInt(getEnv("HOT_QUERY_IDLE_MS"), DEFAULT_IDLE_MS),
    maxSessions: parsePositiveInt(getEnv("HOT_QUERY_MAX_SESSIONS"), DEFAULT_MAX),
  };
}
