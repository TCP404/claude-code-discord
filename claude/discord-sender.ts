/**
 * Claude → Discord message sender.
 * Orchestrates status line management and dispatches to per-type renderers.
 *
 * @module claude/discord-sender
 */

import type { ClaudeMessage, DiscordSender, RendererContext, TrackedMessage } from "./types.ts";
import type { MessageContent } from "../discord/types.ts";
import { getUsage, recordUsage } from "./session-usage.ts";
import { hiddenMessageTypes, toStatusLine } from "./sender-utils.ts";
import {
  deliverFileMarkers,
  renderOther,
  renderPermissionDenied,
  renderSystem,
  renderTaskNotification,
  renderTaskStarted,
  renderText,
  renderThinking,
  renderToolProgress,
  renderToolResult,
  renderToolSummary,
  renderToolUse,
} from "./sender-renderers.ts";

// Re-export public API that other modules depend on
export { FILE_MARKER_REGEX, hiddenMessageTypes } from "./sender-utils.ts";
export type { DiscordSender, TrackedMessage } from "./types.ts";

// Store full content for expand functionality
export const expandableContent = new Map<string, string>();

// Store file paths for button-triggered uploads
export const pendingFileUploads = new Map<string, { path: string; name: string }>();

export function createClaudeSender(
  sender: DiscordSender,
  options?: { isThread?: boolean; sessionId?: string },
) {
  const isThread = options?.isThread ?? false;
  let currentSessionId = options?.sessionId;

  // Status line state
  let statusMsg: TrackedMessage | null = null;
  let statusStartTime = 0;
  let visibleSentSinceStatus = false;
  let lastStatusLine: string | null = null;
  let queueContext: { count: number; sessionId: string } | null = null;

  // Serializes the four status-line writers (updateStatus / refreshQueueStatus
  // / finalizeStatus / clearStatus). Without this, two concurrent calls can
  // both enter the "delete + sendTracked" branch and produce duplicate status
  // messages on Discord (only the latest reference is kept locally; the older
  // ones become orphaned and never get cleaned up).
  let statusLock: Promise<void> = Promise.resolve();
  function withStatusLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = statusLock.then(fn, fn);
    statusLock = next.then(() => {}, () => {});
    return next;
  }

  function buildStatusPayload(line: string): MessageContent {
    const elapsed = ((Date.now() - statusStartTime) / 1000).toFixed(0);
    let content = `${line}  \`${elapsed}s\``;
    const components: NonNullable<MessageContent["components"]> = [];
    if (queueContext && queueContext.count > 0) {
      content += `\n📥 Queued: ${queueContext.count} message${queueContext.count === 1 ? "" : "s"}`;
      components.push({
        type: "actionRow",
        components: [{
          type: "button",
          customId: `queue-clear:${queueContext.sessionId}`,
          label: `❌ Clear queue (${queueContext.count})`,
          style: "danger",
        }],
      });
    }
    // Always return `components` (even empty) so Discord's `edit` clears
    // any stale ActionRow attached to this message. Without this, a stale
    // "Clear queue" button lingers after the queue is drained.
    return { content, components };
  }

  function updateStatus(line: string): Promise<void> {
    if (!sender.sendTracked) return Promise.resolve();
    return withStatusLock(async () => {
      lastStatusLine = line;
      try {
        if (statusMsg && !visibleSentSinceStatus) {
          await statusMsg.edit(buildStatusPayload(line));
        } else {
          if (statusMsg) {
            try {
              await statusMsg.delete();
            } catch { /* ignore */ }
            statusMsg = null;
          }
          statusStartTime = Date.now();
          statusMsg = await sender.sendTracked!(buildStatusPayload(line));
          visibleSentSinceStatus = false;
        }
      } catch { /* message may have been deleted */ }
    });
  }

  /**
   * Re-render the status line so that any queue-context change becomes visible.
   *
   * If no status line exists yet (e.g. the current turn hasn't produced a
   * single hidden tool message), we create one with a placeholder so the
   * queue badge + clear button can be shown. Without this, queueing during
   * a "talk-only" turn would silently fail to surface in the UI.
   */
  function refreshQueueStatus(): Promise<void> {
    if (!sender.sendTracked) return Promise.resolve();
    return withStatusLock(async () => {
      const line = lastStatusLine ?? "⏸️ Agent busy";
      try {
        if (statusMsg && !visibleSentSinceStatus) {
          await statusMsg.edit(buildStatusPayload(line));
        } else {
          if (statusMsg) {
            try {
              await statusMsg.delete();
            } catch { /* ignore */ }
            statusMsg = null;
          }
          statusStartTime = Date.now();
          statusMsg = await sender.sendTracked!(buildStatusPayload(line));
          visibleSentSinceStatus = false;
          if (lastStatusLine === null) lastStatusLine = line;
        }
      } catch { /* ignore — message may have been deleted */ }
    });
  }

  function setQueueContext(ctx: { count: number; sessionId: string } | null): void {
    queueContext = ctx;
  }

  function finalizeStatus(content: string): Promise<void> {
    if (!sender.sendTracked) return Promise.resolve();
    return withStatusLock(async () => {
      queueContext = null;
      lastStatusLine = null;
      try {
        if (statusMsg && !visibleSentSinceStatus) {
          await statusMsg.edit({ content, components: [] });
        } else {
          if (statusMsg) {
            try {
              await statusMsg.delete();
            } catch { /* ignore */ }
            statusMsg = null;
          }
          statusMsg = await sender.sendTracked!({ content });
          visibleSentSinceStatus = false;
        }
      } catch { /* ignore */ }
    });
  }

  function clearStatus(): Promise<void> {
    return withStatusLock(async () => {
      queueContext = null;
      lastStatusLine = null;
      if (statusMsg) {
        try {
          await statusMsg.delete();
        } catch { /* ignore */ }
        statusMsg = null;
      }
    });
  }

  // Renderer context shared across all renderers
  const sentFilePaths = new Set<string>();
  const ctx: RendererContext = {
    expandableContent,
    pendingFileUploads,
    sentFilePaths,
    isThread,
    get currentSessionId() {
      return currentSessionId;
    },
    setCurrentSessionId: (id: string) => {
      currentSessionId = id;
    },
  };

  async function sendVisible(content: MessageContent) {
    visibleSentSinceStatus = true;
    await sender.sendMessage(content);
  }

  const sendClaudeMessages = async function (messages: ClaudeMessage[]) {
    for (const msg of messages) {
      // File marker extraction from tool_result (even when hidden)
      if (msg.type === "tool_result" && msg.content) {
        const filePayloads = await deliverFileMarkers(msg.content, ctx);
        for (const payload of filePayloads) {
          await sendVisible(payload);
        }
      }

      // Hidden messages → status line
      if (msg.type === "system") {
        const subkey = msg.metadata?.subtype === "completion" ? "system:completion" : "system";
        if (hiddenMessageTypes.has(subkey)) {
          if (msg.metadata?.subtype === "completion") {
            const activeSessionId = currentSessionId || msg.metadata?.session_id;
            const isHot = msg.metadata?._hotReuse !== undefined;
            if (activeSessionId && msg.metadata?.total_cost_usd !== undefined) {
              recordUsage(
                activeSessionId,
                msg.metadata.total_cost_usd,
                msg.metadata?.duration_ms ?? 0,
                isHot,
              );
            }
            const showCost = Deno.env.get("SHOW_COST") !== "false";
            if (showCost && msg.metadata?.total_cost_usd !== undefined) {
              const sessionUsage = activeSessionId ? getUsage(activeSessionId) : undefined;
              const turnCost = sessionUsage?.lastTurnCost ?? msg.metadata.total_cost_usd;
              const costPart = sessionUsage && sessionUsage.queryCount > 1
                ? `$${turnCost.toFixed(4)} (Σ$${
                  sessionUsage.totalCost.toFixed(4)
                } ×${sessionUsage.queryCount})`
                : `$${turnCost.toFixed(4)}`;
              const turnDur = sessionUsage?.lastTurnDuration ?? msg.metadata?.duration_ms;
              const durPart = turnDur !== undefined
                ? ` | ${(turnDur / 1000).toFixed(1)}s`
                : "";
              const hotPart = msg.metadata?._hotReuse !== undefined
                ? ` | 🔥${msg.metadata._hotReuse}`
                : "";
              await finalizeStatus(`✅ ${costPart}${durPart}${hotPart}`);
            } else {
              await clearStatus();
            }
          } else {
            const line = toStatusLine(msg);
            if (line) await updateStatus(line);
          }
          continue;
        }
      } else if (hiddenMessageTypes.has(msg.type)) {
        const line = toStatusLine(msg);
        if (line) await updateStatus(line);
        continue;
      }

      // Dispatch visible messages to renderers
      switch (msg.type) {
        case "text": {
          const textPayloads = renderText(msg);
          for (const p of textPayloads) await sendVisible(p);
          // Deliver file markers from text content
          const filePayloads = await deliverFileMarkers(msg.content, ctx);
          for (const p of filePayloads) await sendVisible(p);
          break;
        }

        case "tool_use": {
          const payloads = renderToolUse(msg, ctx);
          for (const p of payloads) await sendVisible(p);
          break;
        }

        case "tool_result": {
          const payload = renderToolResult(msg, ctx);
          if (payload) await sendVisible(payload);
          break;
        }

        case "thinking": {
          const payloads = renderThinking(msg);
          for (const p of payloads) await sendVisible(p);
          break;
        }

        case "system": {
          if (msg.metadata?.subtype === "completion") await clearStatus();
          const payload = renderSystem(msg, ctx);
          await sendVisible(payload);
          break;
        }

        case "other": {
          const payloads = renderOther(msg);
          for (const p of payloads) await sendVisible(p);
          break;
        }

        case "permission_denied": {
          await sendVisible(renderPermissionDenied(msg));
          break;
        }

        case "task_started": {
          await sendVisible(renderTaskStarted(msg));
          break;
        }

        case "task_notification": {
          await sendVisible(renderTaskNotification(msg));
          break;
        }

        case "tool_progress": {
          const payload = renderToolProgress(msg);
          if (payload) await sendVisible(payload);
          break;
        }

        case "tool_summary": {
          const payload = renderToolSummary(msg);
          if (payload) await sendVisible(payload);
          break;
        }
      }
    }
  };

  return {
    send: sendClaudeMessages,
    setSessionId: (id: string) => {
      currentSessionId = id;
    },
    refreshQueueStatus,
    setQueueContext,
  };
}
