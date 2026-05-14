/**
 * Per-message-type renderers for the Claude → Discord sender.
 * Each function takes a ClaudeMessage and returns MessageContent to send.
 *
 * @module claude/sender-renderers
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { splitText } from "../discord/utils.ts";
import type { ClaudeMessage, RendererContext } from "./types.ts";
import type { EmbedData, MessageContent } from "../discord/types.ts";
import { generatePreview } from "./file-preview.ts";
import { getUsage, recordUsage } from "./session-usage.ts";
import {
  createActionButtons,
  FILE_MARKER_REGEX,
  formatStopReason,
  truncateContent,
} from "./sender-utils.ts";

export type { RendererContext } from "./types.ts";

/** Detect [FILE:...] markers, resolve paths, and return file delivery payloads. */
export async function deliverFileMarkers(
  text: string,
  ctx: RendererContext,
): Promise<MessageContent[]> {
  const results: MessageContent[] = [];
  for (const match of text.matchAll(FILE_MARKER_REGEX)) {
    let cleanPath = match[1].replace(/[`()"']/g, "");
    if (!cleanPath.startsWith("/")) {
      cleanPath = resolve(Deno.cwd(), cleanPath);
    }
    if (ctx.sentFilePaths.has(cleanPath)) continue;
    if (existsSync(cleanPath)) {
      ctx.sentFilePaths.add(cleanPath);
      const preview = await generatePreview(cleanPath);
      if (preview) {
        results.push(preview.content);
      } else {
        const fileName = cleanPath.split("/").pop() || "attachment";
        const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        ctx.pendingFileUploads.set(fileId, { path: cleanPath, name: fileName });
        const ext = fileName.split(".").pop()?.toLowerCase() || "";
        const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);
        results.push({
          embeds: [{
            color: 0x2b82d4,
            title: `${isImage ? "🖼️" : "📎"} ${fileName}`,
            timestamp: true,
          }],
          components: [{
            type: "actionRow",
            components: [{
              type: "button",
              customId: `file:${fileId}`,
              label: isImage ? "📷 查看图片" : "📥 下载文件",
              style: "primary",
            }],
          }],
        });
      }
    }
  }
  return results;
}

export function renderText(msg: ClaudeMessage): MessageContent[] {
  const fileMarkers: string[] = [];
  const displayText = msg.content.replace(FILE_MARKER_REGEX, (_, path) => {
    fileMarkers.push(path);
    return "";
  }).trim();

  const results: MessageContent[] = [];
  if (displayText) {
    const chunks = splitText(displayText, 2000);
    for (const chunk of chunks) {
      results.push({ content: chunk });
    }
  }
  return results;
}

export function renderToolUse(msg: ClaudeMessage, ctx: RendererContext): MessageContent[] {
  if (msg.metadata?.name === "TodoWrite") {
    return [renderTodoWrite(msg)];
  }

  const toolName = msg.metadata?.name || "Unknown";

  if (toolName === "Edit") {
    return [renderEditTool(msg)];
  }

  return [renderGenericTool(msg, toolName, ctx)];
}

function renderTodoWrite(msg: ClaudeMessage): MessageContent {
  const todos = msg.metadata?.input?.todos || [];
  const statusEmojis: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
  };
  const priorityEmojis: Record<string, string> = {
    high: "🔴",
    medium: "🟡",
    low: "🟢",
  };

  let todoList = "";
  if (todos.length === 0) {
    todoList = "Task list is empty";
  } else {
    for (const todo of todos) {
      const statusEmoji = statusEmojis[todo.status] || "❓";
      const priorityEmoji = priorityEmojis[todo.priority] || "";
      const priorityText = priorityEmoji ? `${priorityEmoji} ` : "";
      todoList += `${statusEmoji} ${priorityText}**${todo.content}**\n`;
    }
  }

  return {
    embeds: [{
      color: 0x9932cc,
      title: "📝 Todo List Updated",
      description: todoList,
      footer: {
        text: "⏳ Pending | 🔄 In Progress | ✅ Completed | 🔴 High | 🟡 Medium | 🟢 Low",
      },
      timestamp: true,
    }],
  };
}

function renderEditTool(msg: ClaudeMessage): MessageContent {
  const filePath = msg.metadata.input?.file_path || "Unknown file";
  const oldString = msg.metadata.input?.old_string || "";
  const newString = msg.metadata.input?.new_string || "";

  const fields = [
    { name: "📁 File Path", value: `\`${filePath}\``, inline: false },
  ];

  if (oldString) {
    const { preview: oldPreview } = truncateContent(oldString, 3, 150);
    fields.push({
      name: "🔴 Replacing",
      value: `\`\`\`\n${oldPreview}\n\`\`\``,
      inline: false,
    });
  }

  if (newString) {
    const { preview: newPreview } = truncateContent(newString, 3, 150);
    fields.push({
      name: "🟢 With",
      value: `\`\`\`\n${newPreview}\n\`\`\``,
      inline: false,
    });
  }

  return {
    embeds: [{
      color: 0xffaa00,
      title: "✏️ Tool Use: Edit",
      fields,
      timestamp: true,
    }],
  };
}

function renderGenericTool(
  msg: ClaudeMessage,
  toolName: string,
  ctx: RendererContext,
): MessageContent {
  const inputStr = JSON.stringify(msg.metadata.input || {}, null, 2);
  const { preview, isTruncated } = truncateContent(inputStr, 10, 800);

  const messageContent: MessageContent = {
    embeds: [{
      color: 0x0099ff,
      title: `🔧 Tool Use: ${toolName}`,
      description: `\`\`\`json\n${preview}\n\`\`\``,
      timestamp: true,
    }],
  };

  if (isTruncated) {
    const expandId = `tool-${msg.metadata?.id || Date.now()}`;
    ctx.expandableContent.set(expandId, inputStr);
    messageContent.components = [{
      type: "actionRow",
      components: [{
        type: "button",
        customId: `expand:${expandId}`,
        label: "📖 Show Full Content",
        style: "secondary",
      }],
    }];
  }

  return messageContent;
}

export function renderToolResult(msg: ClaudeMessage, ctx: RendererContext): MessageContent | null {
  let cleanContent = msg.content;
  cleanContent = cleanContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, "\n\n").trim();

  if (!cleanContent) return null;

  const { preview, isTruncated, totalLines } = truncateContent(cleanContent);

  const messageContent: MessageContent = {
    embeds: [{
      color: 0x00ffff,
      title: `✅ Tool Result${isTruncated ? ` (+${totalLines - 15} more lines)` : ""}`,
      description: `\`\`\`\n${preview}\n\`\`\``,
      timestamp: true,
    }],
  };

  if (isTruncated) {
    const expandId = `result-${Date.now()}`;
    ctx.expandableContent.set(expandId, cleanContent);
    messageContent.components = [{
      type: "actionRow",
      components: [{
        type: "button",
        customId: `expand:${expandId}`,
        label: "📖 Show Full Result",
        style: "secondary",
      }],
    }];
  }

  return messageContent;
}

export function renderThinking(msg: ClaudeMessage): MessageContent[] {
  const chunks = splitText(msg.content, 4000);
  return chunks.map((chunk, i) => ({
    embeds: [{
      color: 0x9b59b6,
      title: chunks.length > 1 ? `💭 Thinking (${i + 1}/${chunks.length})` : "💭 Thinking",
      description: chunk,
      timestamp: true,
    }],
  }));
}

export function renderSystem(msg: ClaudeMessage, ctx: RendererContext): MessageContent {
  const embedData: EmbedData = {
    color: msg.metadata?.subtype === "completion" ? 0x00ff00 : 0xaaaaaa,
    title: msg.metadata?.subtype === "completion"
      ? "✅ Claude Code Complete"
      : `⚙️ System: ${msg.metadata?.subtype || "info"}`,
    timestamp: true,
    fields: [],
  };

  if (msg.metadata?.cwd) {
    embedData.fields!.push({
      name: "Working Directory",
      value: `\`${msg.metadata.cwd}\``,
      inline: false,
    });
  }
  if (msg.metadata?.session_id) {
    if (!ctx.currentSessionId) ctx.setCurrentSessionId(msg.metadata.session_id);
    embedData.fields!.push({
      name: "Session ID",
      value: `\`${msg.metadata.session_id}\``,
      inline: false,
    });
  }
  if (msg.metadata?.model) {
    embedData.fields!.push({ name: "Model", value: msg.metadata.model, inline: true });
  }

  const activeSessionId = ctx.currentSessionId || msg.metadata?.session_id;
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
    const costStr = sessionUsage && sessionUsage.queryCount > 1
      ? `$${turnCost.toFixed(4)} (Σ$${
        sessionUsage.totalCost.toFixed(4)
      } ×${sessionUsage.queryCount})`
      : `$${turnCost.toFixed(4)}`;
    embedData.fields!.push({ name: "Cost", value: costStr, inline: true });
  }
  if (showCost && msg.metadata?.duration_ms !== undefined) {
    const sessionUsage = activeSessionId ? getUsage(activeSessionId) : undefined;
    const turnDur = sessionUsage?.lastTurnDuration ?? msg.metadata.duration_ms;
    const durStr = sessionUsage && sessionUsage.queryCount > 1
      ? `${(turnDur / 1000).toFixed(1)}s (Σ${
        (sessionUsage.totalDuration / 1000).toFixed(1)
      }s)`
      : `${(turnDur / 1000).toFixed(1)}s`;
    embedData.fields!.push({ name: "Duration", value: durStr, inline: true });
  }

  const stopReasonDisplay = formatStopReason(
    msg.metadata?.stop_reason,
    msg.metadata?.sdkSubtype,
  );
  if (stopReasonDisplay) {
    embedData.fields!.push({ name: "Stop Reason", value: stopReasonDisplay, inline: true });
  }

  if (msg.metadata?.subtype === "shutdown") {
    embedData.color = 0xff0000;
    embedData.title = "🛑 Shutdown";
    embedData.description = `Bot stopped by signal ${msg.metadata.signal}`;
    embedData.fields = [
      { name: "Category", value: msg.metadata.categoryName, inline: true },
      { name: "Repository", value: msg.metadata.repoName, inline: true },
      { name: "Branch", value: msg.metadata.branchName, inline: true },
    ];
  }

  const messageContent: MessageContent = { embeds: [embedData] };

  if (!ctx.isThread && msg.metadata?.subtype === "completion") {
    messageContent.components = [
      { type: "actionRow", components: createActionButtons() },
    ];
  }

  return messageContent;
}

export function renderOther(msg: ClaudeMessage): MessageContent[] {
  const jsonStr = JSON.stringify(msg.metadata || msg.content, null, 2);
  const maxChunkLength = 4096 - "```json\n\n```".length - 50;
  const chunks = splitText(jsonStr, maxChunkLength);
  return chunks.map((chunk, i) => ({
    embeds: [{
      color: 0xffaa00,
      title: chunks.length > 1 ? `Other Content (${i + 1}/${chunks.length})` : "Other Content",
      description: `\`\`\`json\n${chunk}\n\`\`\``,
      timestamp: true,
    }],
  }));
}

export function renderPermissionDenied(msg: ClaudeMessage): MessageContent {
  const toolName = msg.metadata?.toolName || "Unknown";
  const toolInput = msg.metadata?.toolInput || {};
  const inputPreview = JSON.stringify(toolInput, null, 2);
  const { preview } = truncateContent(inputPreview, 6, 500);

  return {
    embeds: [{
      color: 0xff4444,
      title: `🚫 Permission Denied: ${toolName}`,
      description:
        "This tool was blocked — it isn't in the pre-approved whitelist and no interactive permission handler matched.",
      fields: [
        { name: "Tool", value: `\`${toolName}\``, inline: true },
        { name: "Input Preview", value: `\`\`\`json\n${preview}\n\`\`\``, inline: false },
      ],
      footer: {
        text: "Change operation mode with /settings → Mode Settings to allow more tools",
      },
      timestamp: true,
    }],
  };
}

export function renderTaskStarted(msg: ClaudeMessage): MessageContent {
  const description = msg.metadata?.description || msg.content || "Starting subagent task...";
  const taskType = msg.metadata?.taskType;

  return {
    embeds: [{
      color: 0x5865f2,
      title: "🚀 Subagent Task Started",
      description,
      fields: taskType ? [{ name: "Type", value: taskType, inline: true }] : [],
      timestamp: true,
    }],
  };
}

export function renderTaskNotification(msg: ClaudeMessage): MessageContent {
  const status = msg.metadata?.status || "unknown";
  const summary = msg.metadata?.summary || msg.content || "No summary";
  const statusEmoji = status === "completed" ? "✅" : status === "failed" ? "❌" : "⏹️";
  const statusColor = status === "completed" ? 0x00ff00 : status === "failed" ? 0xff0000 : 0xffaa00;

  return {
    embeds: [{
      color: statusColor,
      title: `${statusEmoji} Subagent Task ${status.charAt(0).toUpperCase() + status.slice(1)}`,
      description: summary.length > 4000 ? summary.substring(0, 3997) + "..." : summary,
      timestamp: true,
    }],
  };
}

export function renderToolProgress(msg: ClaudeMessage): MessageContent | null {
  const elapsed = msg.metadata?.elapsedSeconds || 0;
  if (elapsed < 5) return null;

  const toolName = msg.metadata?.toolName || "Unknown";
  return {
    embeds: [{
      color: 0x888888,
      title: `⏳ ${toolName} running...`,
      description: `Elapsed: ${elapsed.toFixed(1)}s`,
      timestamp: true,
    }],
  };
}

export function renderToolSummary(msg: ClaudeMessage): MessageContent | null {
  if (!msg.content) return null;
  return {
    embeds: [{
      color: 0x00ccff,
      title: "📋 Tool Summary",
      description: msg.content.length > 4000 ? msg.content.substring(0, 3997) + "..." : msg.content,
      timestamp: true,
    }],
  };
}
