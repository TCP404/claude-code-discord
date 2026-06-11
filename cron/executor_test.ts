/** @module cron/executor_test — Tests for scheduler executor thread/session wiring. */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createSchedulerExecutor } from "./executor.ts";
import type { ScheduledTask } from "./types.ts";
import type { SessionThreadCallbacks } from "../claude/command.ts";
import type { WorkspaceManager } from "../core/workspace-manager.ts";
import type { SessionThreadManager } from "../discord/session-threads.ts";

Deno.test("SchedulerExecutor: streamed session_id keeps scheduled thread resumable after stop", async () => {
  const task: ScheduledTask = {
    id: "task-1",
    workspaceName: "ops",
    command: "/daily-check",
    schedule: { type: "daily", time: "09:00" },
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
  };

  const updates: Array<[string, string]> = [];
  const senderSessionIds: string[] = [];
  const mappedChannels: Array<[string, string]> = [];
  const hotQuerySettings: Array<[string, boolean | undefined]> = [];

  const workspaceManager = {
    findByName: (name: string) =>
      name === "ops" ? { name: "ops", path: "/work/ops", channelId: "channel-1" } : undefined,
  } as unknown as WorkspaceManager;

  const sessionThreadCallbacks = {
    createThreadSender: async () => ({
      sender: {
        send: async () => {},
        setSessionId: (sessionId: string) => senderSessionIds.push(sessionId),
      },
      threadSessionKey: "pending_scheduler",
      threadChannelId: "thread-1",
    }),
    getThreadSender: async () => undefined,
    updateSessionId: (oldKey: string, newSessionId: string) => {
      updates.push([oldKey, newSessionId]);
    },
  } satisfies SessionThreadCallbacks;

  const sessionThreadManager = {
    setHotQuery: (sessionId: string, enabled: boolean | undefined) => {
      hotQuerySettings.push([sessionId, enabled]);
    },
  } as unknown as SessionThreadManager;

  const executor = createSchedulerExecutor({
    workspaceManager,
    sessionThreadCallbacks,
    sessionThreadManager,
    setSessionForChannel: (channelId, sessionId) => mappedChannels.push([channelId, sessionId]),
    runClaude: async (
      _workDir,
      _prompt,
      _controller,
      _sessionId,
      _onChunk,
      onStreamJson,
    ) => {
      onStreamJson?.({ type: "system", subtype: "init", session_id: "sess-123" });
      return { response: "Request was cancelled" };
    },
  });

  const threadId = await executor.execute(task);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(threadId, "thread-1");
  assertEquals(updates, [["pending_scheduler", "sess-123"]]);
  assertEquals(senderSessionIds, ["sess-123"]);
  assertEquals(mappedChannels, [["thread-1", "sess-123"]]);
  assertEquals(hotQuerySettings, [["sess-123", true]]);
});
