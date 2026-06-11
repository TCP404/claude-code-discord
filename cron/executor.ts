/** @module cron/executor — Bridges scheduler with Discord thread creation + Claude query. */

import type { ScheduledTask } from "./types.ts";
import type { SchedulerExecutor } from "./scheduler.ts";
import type { SessionThreadCallbacks } from "../claude/command.ts";
import type { WorkspaceManager } from "../core/workspace-manager.ts";
import type { SessionThreadManager } from "../discord/session-threads.ts";
import { type ClaudeModelOptions, sendToClaudeCode } from "../claude/client.ts";
import { convertToClaudeMessages } from "../claude/message-converter.ts";

export interface ExecutorDeps {
  workspaceManager: WorkspaceManager;
  sessionThreadCallbacks: SessionThreadCallbacks;
  sessionThreadManager: SessionThreadManager;
  /** Register session → channel mapping so thread auto-resume works */
  setSessionForChannel?: (channelId: string, sessionId: string) => void;
  getQueryOptions?: () => Partial<ClaudeModelOptions>;
  runClaude?: typeof sendToClaudeCode;
}

export function createSchedulerExecutor(deps: ExecutorDeps): SchedulerExecutor {
  const {
    workspaceManager,
    sessionThreadCallbacks,
    sessionThreadManager,
    setSessionForChannel,
    getQueryOptions,
    runClaude = sendToClaudeCode,
  } = deps;

  return {
    async execute(task: ScheduledTask): Promise<string> {
      const workspace = workspaceManager.findByName(task.workspaceName);
      if (!workspace) {
        throw new Error(`Workspace "${task.workspaceName}" not found`);
      }

      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${
        String(now.getDate()).padStart(2, "0")
      }`;
      const threadName = task.threadName ||
        `${task.command.slice(0, 40)} (${dateStr})`;

      // Create a new thread in the workspace channel
      const threadResult = await sessionThreadCallbacks.createThreadSender(
        task.command,
        undefined,
        threadName,
        workspace.channelId,
      );

      // Fire and forget — send the command to Claude in the thread.
      // We don't await completion; success = thread created + query started.
      const controller = new AbortController();
      let threadSessionKey = threadResult.threadSessionKey;
      let boundSessionId: string | undefined;
      const bindSession = (sessionId: string | undefined) => {
        if (!sessionId || sessionId === boundSessionId) return;
        sessionThreadCallbacks.updateSessionId(threadSessionKey, sessionId);
        threadSessionKey = sessionId;
        boundSessionId = sessionId;
        threadResult.sender.setSessionId(sessionId);
        if (setSessionForChannel) {
          setSessionForChannel(threadResult.threadChannelId, sessionId);
        }
        // Enable hot query so the session stays alive for auth callbacks etc.
        sessionThreadManager.setHotQuery(sessionId, true);
      };
      const markUnresumable = () => {
        if (boundSessionId || !threadSessionKey.startsWith("pending_")) return;
        sessionThreadCallbacks.updateSessionId(
          threadSessionKey,
          `failed_${threadSessionKey}`,
        );
      };
      runClaude(
        workspace.path,
        task.command,
        controller,
        undefined,
        undefined,
        (jsonData) => {
          if (typeof jsonData?.session_id === "string") {
            bindSession(jsonData.session_id);
          }
          const messages = convertToClaudeMessages(jsonData);
          if (messages.length > 0) {
            threadResult.sender.send(messages).catch(() => {});
          }
        },
        getQueryOptions?.() as ClaudeModelOptions | undefined,
      ).then((result) => {
        bindSession(result.sessionId);
        markUnresumable();
      }).catch((err) => {
        markUnresumable();
        console.error(`[Scheduler] Query failed for "${task.command}":`, err);
      });

      return threadResult.threadChannelId;
    },
  };
}
