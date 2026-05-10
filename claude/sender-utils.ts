/**
 * Utility functions and constants for the Claude → Discord message sender.
 * Pure functions with no side effects.
 *
 * @module claude/sender-utils
 */

import type { ClaudeMessage } from "./types.ts";
import type { ComponentData } from "../discord/types.ts";

// Marker pattern: model outputs [FILE:/path/to/file] to explicitly deliver a file
export const FILE_MARKER_REGEX = /\[FILE:((?:\/|\.\/)[^\]]+)\]/g;

// Message types hidden by default — toggled via /show_system, /show_tool_details
export const hiddenMessageTypes = new Set<string>([
  "system",
  "system:completion",
  "tool_use",
  "tool_result",
  "tool_progress",
  "tool_summary",
  "other",
]);

export function createActionButtons(): ComponentData[] {
  return [
    {
      type: "button",
      customId: "workflow:git-status",
      label: "📊 Git Status",
      style: "secondary",
    },
    {
      type: "button",
      customId: "prompt-history",
      label: "📜 Prompt History",
      style: "secondary",
    },
  ];
}

export function truncateContent(
  content: string,
  maxLines = 15,
  maxChars = 1000,
): { preview: string; isTruncated: boolean; totalLines: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const truncatedLines = lines.slice(0, maxLines);
  const preview = truncatedLines.join("\n");

  if (preview.length > maxChars) {
    return {
      preview: preview.substring(0, maxChars - 3) + "...",
      isTruncated: true,
      totalLines,
    };
  }

  return {
    preview,
    isTruncated: lines.length > maxLines,
    totalLines,
  };
}

export function formatStopReason(stopReason?: string, sdkSubtype?: string): string | null {
  if (sdkSubtype && sdkSubtype !== "success") {
    const subtypeMap: Record<string, string> = {
      "error_max_turns": "🔄 Hit turn limit",
      "error_budget": "💰 Budget exceeded",
      "error_tool": "🔧 Tool error",
      "error_streaming": "📡 Streaming error",
    };
    if (subtypeMap[sdkSubtype]) return subtypeMap[sdkSubtype];
  }

  if (!stopReason) return null;

  const reasonMap: Record<string, string> = {
    "end_turn": "✅ Completed",
    "max_tokens": "⚠️ Hit token limit",
    "refusal": "🚫 Request declined",
    "stop_sequence": "⏹️ Stop sequence",
    "tool_use": "🔧 Tool use",
  };

  return reasonMap[stopReason] ?? null;
}

export function getFileTypeInfo(filePath: string): { icon: string; language: string } {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  const fileTypes: Record<string, { icon: string; language: string }> = {
    "ts": { icon: "📘", language: "TypeScript" },
    "tsx": { icon: "⚛️", language: "React/TypeScript" },
    "js": { icon: "📙", language: "JavaScript" },
    "jsx": { icon: "⚛️", language: "React/JavaScript" },
    "py": { icon: "🐍", language: "Python" },
    "rs": { icon: "🦀", language: "Rust" },
    "go": { icon: "🐹", language: "Go" },
    "java": { icon: "☕", language: "Java" },
    "md": { icon: "📝", language: "Markdown" },
    "json": { icon: "📋", language: "JSON" },
    "yml": { icon: "⚙️", language: "YAML" },
    "yaml": { icon: "⚙️", language: "YAML" },
    "html": { icon: "🌐", language: "HTML" },
    "css": { icon: "🎨", language: "CSS" },
    "scss": { icon: "🎨", language: "SCSS" },
  };

  return fileTypes[ext] || { icon: "📄", language: "Text" };
}

export function formatGenericTool(
  toolName: string,
  // deno-lint-ignore no-explicit-any
  metadata: any,
): { title: string; color: number; description: string } {
  const inputStr = JSON.stringify(metadata.input || {}, null, 2);
  const { preview } = truncateContent(inputStr, 10, 800);

  return {
    title: `🔧 Tool Use: ${toolName}`,
    color: 0x0099ff,
    description: `\`\`\`json\n${preview}\n\`\`\``,
  };
}

export function toStatusLine(msg: ClaudeMessage): string | null {
  switch (msg.type) {
    case "tool_use": {
      const name = msg.metadata?.name || "Unknown";
      const input = msg.metadata?.input || {};
      if (name === "Bash") {
        return `⚡ Running: \`${(input.command as string || "").substring(0, 80)}\``;
      }
      if (name === "Read") return `📖 Reading: \`${input.file_path || ""}\``;
      if (name === "Edit" || name === "Write") return `✏️ Editing: \`${input.file_path || ""}\``;
      if (name === "Glob") return `🔍 Searching: \`${input.pattern || ""}\``;
      if (name === "Grep") return `🔍 Grep: \`${input.pattern || ""}\``;
      if (name === "Agent") return `🤖 Spawning agent...`;
      return `🔧 ${name}`;
    }
    case "tool_result":
      return null;
    case "tool_progress":
      return `⏳ ${msg.metadata?.toolName || "Tool"} running... (${
        msg.metadata?.elapsedSeconds?.toFixed(0) || "?"
      }s)`;
    case "tool_summary":
      return null;
    case "system": {
      if (msg.metadata?.subtype === "completion") return null;
      return `⚙️ ${msg.metadata?.subtype || "init"}`;
    }
    default:
      return null;
  }
}
