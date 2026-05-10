/** @module claude/hot-query-config_test — Tests for env-var config reading. */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { readHotQueryConfig } from "./hot-query-config.ts";

Deno.test("readHotQueryConfig: defaults when no env set", () => {
  const cfg = readHotQueryConfig(() => undefined);
  assertEquals(cfg.enabled, true);
  assertEquals(cfg.idleMs, 900_000);
  assertEquals(cfg.maxSessions, 3);
});

Deno.test("readHotQueryConfig: HOT_QUERY_ENABLED=false disables", () => {
  const env: Record<string, string> = { HOT_QUERY_ENABLED: "false" };
  const cfg = readHotQueryConfig((k) => env[k]);
  assertEquals(cfg.enabled, false);
});

Deno.test("readHotQueryConfig: custom idleMs and maxSessions", () => {
  const env: Record<string, string> = {
    HOT_QUERY_IDLE_MS: "60000",
    HOT_QUERY_MAX_SESSIONS: "5",
  };
  const cfg = readHotQueryConfig((k) => env[k]);
  assertEquals(cfg.idleMs, 60_000);
  assertEquals(cfg.maxSessions, 5);
});

Deno.test("readHotQueryConfig: invalid numbers fall back to defaults", () => {
  const env: Record<string, string> = {
    HOT_QUERY_IDLE_MS: "abc",
    HOT_QUERY_MAX_SESSIONS: "-1",
  };
  const cfg = readHotQueryConfig((k) => env[k]);
  assertEquals(cfg.idleMs, 900_000);
  assertEquals(cfg.maxSessions, 3);
});
