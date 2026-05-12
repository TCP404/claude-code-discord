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

  async function updateStatus(line: string) {
    if (!sender.sendTracked) return;
    const elapsed = ((Date.now() - statusStartTime) / 1000).toFixed(0);
    const content = `${line}  \`${elapsed}s\``;
    try {
      if (statusMsg && !visibleSentSinceStatus) {
        await statusMsg.edit({ content });
      } else {
        if (statusMsg) {
          try {
            await statusMsg.delete();
          } catch { /* ignore */ }
        }
        statusStartTime = Date.now();
        statusMsg = await sender.sendTracked({ content: line });
        visibleSentSinceStatus = false;
      }
    } catch { /* message may have been deleted */ }
  }

  async function finalizeStatus(content: string) {
    if (!sender.sendTracked) return;
    try {
      if (statusMsg && !visibleSentSinceStatus) {
        await statusMsg.edit({ content });
      } else {
        if (statusMsg) {
          try {
            await statusMsg.delete();
          } catch { /* ignore */ }
        }
        statusMsg = await sender.sendTracked({ content });
        visibleSentSinceStatus = false;
      }
    } catch { /* ignore */ }
  }

  async function clearStatus() {
    if (statusMsg) {
      try {
        await statusMsg.delete();
      } catch { /* ignore */ }
      statusMsg = null;
    }
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
            if (activeSessionId && msg.metadata?.total_cost_usd !== undefined) {
              recordUsage(
                activeSessionId,
                msg.metadata.total_cost_usd,
                msg.metadata?.duration_ms ?? 0,
              );
            }
            const showCost = Deno.env.get("SHOW_COST") !== "false";
            if (showCost && msg.metadata?.total_cost_usd !== undefined) {
              const sessionUsage = activeSessionId ? getUsage(activeSessionId) : undefined;
              const costPart = sessionUsage && sessionUsage.queryCount > 1
                ? `$${msg.metadata.total_cost_usd.toFixed(4)} (Σ$${
                  sessionUsage.totalCost.toFixed(4)
                } ×${sessionUsage.queryCount})`
                : `$${msg.metadata.total_cost_usd.toFixed(4)}`;
              const durPart = msg.metadata?.duration_ms !== undefined
                ? ` | ${(msg.metadata.duration_ms / 1000).toFixed(1)}s`
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
  };
}
