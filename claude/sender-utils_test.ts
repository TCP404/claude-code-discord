import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createActionButtons,
  FILE_MARKER_REGEX,
  formatGenericTool,
  formatStopReason,
  getFileTypeInfo,
  toStatusLine,
  truncateContent,
} from "./sender-utils.ts";
import type { ClaudeMessage } from "./types.ts";

// --- FILE_MARKER_REGEX ---

Deno.test("FILE_MARKER_REGEX: matches absolute path", () => {
  const match = [...("[FILE:/tmp/foo.ts]".matchAll(FILE_MARKER_REGEX))];
  assertEquals(match.length, 1);
  assertEquals(match[0][1], "/tmp/foo.ts");
});

Deno.test("FILE_MARKER_REGEX: matches relative path with ./", () => {
  const match = [...("[FILE:./src/bar.js]".matchAll(FILE_MARKER_REGEX))];
  assertEquals(match.length, 1);
  assertEquals(match[0][1], "./src/bar.js");
});

Deno.test("FILE_MARKER_REGEX: matches multiple markers in one string", () => {
  const text = "Here [FILE:/a.ts] and [FILE:/b.ts] done";
  const matches = [...text.matchAll(FILE_MARKER_REGEX)];
  assertEquals(matches.length, 2);
});

Deno.test("FILE_MARKER_REGEX: does not match without leading / or ./", () => {
  const match = [...("[FILE:relative/path.ts]".matchAll(FILE_MARKER_REGEX))];
  assertEquals(match.length, 0);
});

// --- createActionButtons ---

Deno.test("createActionButtons: returns git-status and prompt-history buttons", () => {
  const buttons = createActionButtons();
  assertEquals(buttons.length, 2);
  assertEquals(buttons[0].customId, "workflow:git-status");
  assertEquals(buttons[1].customId, "prompt-history");
});

// --- truncateContent ---

Deno.test("truncateContent: short content is not truncated", () => {
  const result = truncateContent("hello\nworld", 15, 1000);
  assertEquals(result.isTruncated, false);
  assertEquals(result.preview, "hello\nworld");
  assertEquals(result.totalLines, 2);
});

Deno.test("truncateContent: truncates by line count", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const result = truncateContent(lines.join("\n"), 5, 10000);
  assertEquals(result.isTruncated, true);
  assertEquals(result.preview.split("\n").length, 5);
});

Deno.test("truncateContent: truncates by char count", () => {
  const content = "a".repeat(2000);
  const result = truncateContent(content, 100, 500);
  assertEquals(result.isTruncated, true);
  assertEquals(result.preview.length, 500);
  assertEquals(result.preview.endsWith("..."), true);
});

Deno.test("truncateContent: empty content", () => {
  const result = truncateContent("", 15, 1000);
  assertEquals(result.isTruncated, false);
  assertEquals(result.preview, "");
  assertEquals(result.totalLines, 1);
});

// --- formatStopReason ---

Deno.test("formatStopReason: returns null for undefined", () => {
  assertEquals(formatStopReason(undefined, undefined), null);
});

Deno.test("formatStopReason: maps known stop reasons", () => {
  assertEquals(formatStopReason("end_turn"), "✅ Completed");
  assertEquals(formatStopReason("max_tokens"), "⚠️ Hit token limit");
  assertEquals(formatStopReason("refusal"), "🚫 Request declined");
});

Deno.test("formatStopReason: sdk subtype takes priority over stopReason", () => {
  assertEquals(formatStopReason("end_turn", "error_max_turns"), "🔄 Hit turn limit");
});

Deno.test("formatStopReason: success subtype falls through to stopReason", () => {
  assertEquals(formatStopReason("end_turn", "success"), "✅ Completed");
});

Deno.test("formatStopReason: unknown stop reason returns null", () => {
  assertEquals(formatStopReason("something_new"), null);
});

// --- getFileTypeInfo ---

Deno.test("getFileTypeInfo: known extensions", () => {
  assertEquals(getFileTypeInfo("app.ts"), { icon: "📘", language: "TypeScript" });
  assertEquals(getFileTypeInfo("style.css"), { icon: "🎨", language: "CSS" });
  assertEquals(getFileTypeInfo("main.py"), { icon: "🐍", language: "Python" });
});

Deno.test("getFileTypeInfo: unknown extension returns default", () => {
  assertEquals(getFileTypeInfo("data.xyz"), { icon: "📄", language: "Text" });
});

Deno.test("getFileTypeInfo: no extension returns default", () => {
  assertEquals(getFileTypeInfo("Makefile"), { icon: "📄", language: "Text" });
});

Deno.test("getFileTypeInfo: handles path with multiple dots", () => {
  assertEquals(getFileTypeInfo("src/app.module.ts"), { icon: "📘", language: "TypeScript" });
});

// --- formatGenericTool ---

Deno.test("formatGenericTool: formats tool name and input", () => {
  const result = formatGenericTool("MyTool", { input: { key: "value" } });
  assertEquals(result.title, "🔧 Tool Use: MyTool");
  assertEquals(result.color, 0x0099ff);
  assertEquals(result.description.includes('"key"'), true);
});

Deno.test("formatGenericTool: handles missing input gracefully", () => {
  const result = formatGenericTool("Empty", {});
  assertEquals(result.description.includes("{}"), true);
});

// --- toStatusLine ---

Deno.test("toStatusLine: Bash tool shows command", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { name: "Bash", input: { command: "ls -la" } },
  };
  assertEquals(toStatusLine(msg), "⚡ Running: `ls -la`");
});

Deno.test("toStatusLine: Bash truncates long commands to 80 chars", () => {
  const longCmd = "a".repeat(100);
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { name: "Bash", input: { command: longCmd } },
  };
  const result = toStatusLine(msg)!;
  assertEquals(result.includes(longCmd.substring(0, 80)), true);
  assertEquals(result.includes(longCmd), false);
});

Deno.test("toStatusLine: Read tool shows file path", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { name: "Read", input: { file_path: "/src/index.ts" } },
  };
  assertEquals(toStatusLine(msg), "📖 Reading: `/src/index.ts`");
});

Deno.test("toStatusLine: Edit tool shows file path", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { name: "Edit", input: { file_path: "/src/app.ts" } },
  };
  assertEquals(toStatusLine(msg), "✏️ Editing: `/src/app.ts`");
});

Deno.test("toStatusLine: tool_result returns null", () => {
  const msg: ClaudeMessage = { type: "tool_result", content: "ok" };
  assertEquals(toStatusLine(msg), null);
});

Deno.test("toStatusLine: tool_progress shows elapsed seconds", () => {
  const msg: ClaudeMessage = {
    type: "tool_progress",
    content: "",
    metadata: { toolName: "Bash", elapsedSeconds: 5.7 },
  };
  assertEquals(toStatusLine(msg), "⏳ Bash running... (6s)");
});

Deno.test("toStatusLine: system completion returns null", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: { subtype: "completion" },
  };
  assertEquals(toStatusLine(msg), null);
});

Deno.test("toStatusLine: system init shows subtype", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: { subtype: "init" },
  };
  assertEquals(toStatusLine(msg), "⚙️ init");
});

Deno.test("toStatusLine: text type returns null", () => {
  const msg: ClaudeMessage = { type: "text", content: "hello" };
  assertEquals(toStatusLine(msg), null);
});
