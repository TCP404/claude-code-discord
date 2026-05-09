import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  renderText,
  renderToolUse,
  renderToolResult,
  renderThinking,
  renderSystem,
  renderOther,
  renderPermissionDenied,
  renderTaskStarted,
  renderTaskNotification,
  renderToolProgress,
  renderToolSummary,
} from "./sender-renderers.ts";
import type { ClaudeMessage, RendererContext } from "./types.ts";

function createCtx(overrides: Partial<RendererContext> = {}): RendererContext {
  const ctx: RendererContext = {
    expandableContent: new Map(),
    pendingFileUploads: new Map(),
    sentFilePaths: new Set(),
    isThread: false,
    currentSessionId: undefined,
    setCurrentSessionId: (id: string) => { ctx.currentSessionId = id; },
    ...overrides,
  };
  return ctx;
}

// --- renderText ---

Deno.test("renderText: simple text returns content message", () => {
  const results = renderText({ type: "text", content: "hello world" });
  assertEquals(results.length, 1);
  assertEquals(results[0].content, "hello world");
});

Deno.test("renderText: strips FILE markers from display text", () => {
  const results = renderText({ type: "text", content: "See [FILE:/tmp/a.ts] here" });
  assertEquals(results.length, 1);
  assertEquals(results[0].content, "See  here");
});

Deno.test("renderText: only FILE markers and whitespace returns empty", () => {
  const results = renderText({ type: "text", content: "[FILE:/tmp/a.ts]" });
  assertEquals(results.length, 0);
});

Deno.test("renderText: long text splits into 2000-char chunks", () => {
  const longText = "a".repeat(4500);
  const results = renderText({ type: "text", content: longText });
  assertEquals(results.length, 3);
  assertEquals(results[0].content!.length, 2000);
  assertEquals(results[1].content!.length, 2000);
  assertEquals(results[2].content!.length, 500);
});

Deno.test("renderText: empty content returns empty array", () => {
  const results = renderText({ type: "text", content: "" });
  assertEquals(results.length, 0);
});

// --- renderToolUse ---

Deno.test("renderToolUse: TodoWrite renders todo list embed", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: {
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Fix bug", status: "completed", priority: "high" },
          { content: "Write tests", status: "in_progress", priority: "medium" },
        ],
      },
    },
  };
  const results = renderToolUse(msg, createCtx());
  assertEquals(results.length, 1);
  assertEquals(results[0].embeds![0].title, "📝 Todo List Updated");
  assertEquals(results[0].embeds![0].description!.includes("Fix bug"), true);
  assertEquals(results[0].embeds![0].description!.includes("✅"), true);
  assertEquals(results[0].embeds![0].description!.includes("🔄"), true);
});

Deno.test("renderToolUse: TodoWrite with empty list", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { name: "TodoWrite", input: { todos: [] } },
  };
  const results = renderToolUse(msg, createCtx());
  assertEquals(results[0].embeds![0].description, "Task list is empty");
});

Deno.test("renderToolUse: Edit tool shows file path and diff preview", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: {
      name: "Edit",
      input: {
        file_path: "/src/app.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
    },
  };
  const results = renderToolUse(msg, createCtx());
  assertEquals(results.length, 1);
  assertEquals(results[0].embeds![0].title, "✏️ Tool Use: Edit");
  const fields = results[0].embeds![0].fields!;
  assertEquals(fields[0].value, "`/src/app.ts`");
  assertEquals(fields[1].name, "🔴 Replacing");
  assertEquals(fields[2].name, "🟢 With");
});

Deno.test("renderToolUse: Edit tool with empty old/new strings only shows path", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { name: "Edit", input: { file_path: "/f.ts", old_string: "", new_string: "" } },
  };
  const results = renderToolUse(msg, createCtx());
  assertEquals(results[0].embeds![0].fields!.length, 1);
});

Deno.test("renderToolUse: generic tool renders JSON input", () => {
  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { id: "t1", name: "Bash", input: { command: "ls" } },
  };
  const ctx = createCtx();
  const results = renderToolUse(msg, ctx);
  assertEquals(results[0].embeds![0].title, "🔧 Tool Use: Bash");
  assertEquals(results[0].embeds![0].description!.includes("ls"), true);
});

Deno.test("renderToolUse: generic tool with large input adds expand button", () => {
  const bigInput: Record<string, string> = {};
  for (let i = 0; i < 50; i++) bigInput[`key${i}`] = "x".repeat(30);

  const msg: ClaudeMessage = {
    type: "tool_use",
    content: "",
    metadata: { id: "t-big", name: "BigTool", input: bigInput },
  };
  const ctx = createCtx();
  const results = renderToolUse(msg, ctx);
  assertEquals(results[0].components !== undefined, true);
  assertEquals(ctx.expandableContent.size, 1);
});

// --- renderToolResult ---

Deno.test("renderToolResult: renders content in code block", () => {
  const ctx = createCtx();
  const result = renderToolResult({ type: "tool_result", content: "file1.ts\nfile2.ts" }, ctx);
  assertEquals(result !== null, true);
  assertEquals(result!.embeds![0].title!.includes("Tool Result"), true);
  assertEquals(result!.embeds![0].description!.includes("file1.ts"), true);
});

Deno.test("renderToolResult: strips system-reminder tags", () => {
  const content = "real output<system-reminder>secret</system-reminder>more output";
  const ctx = createCtx();
  const result = renderToolResult({ type: "tool_result", content }, ctx);
  assertEquals(result!.embeds![0].description!.includes("secret"), false);
  assertEquals(result!.embeds![0].description!.includes("real output"), true);
});

Deno.test("renderToolResult: returns null for empty content", () => {
  const ctx = createCtx();
  const result = renderToolResult({ type: "tool_result", content: "" }, ctx);
  assertEquals(result, null);
});

Deno.test("renderToolResult: returns null for content that is only system-reminder", () => {
  const ctx = createCtx();
  const result = renderToolResult({
    type: "tool_result",
    content: "<system-reminder>hidden</system-reminder>",
  }, ctx);
  assertEquals(result, null);
});

Deno.test("renderToolResult: large content adds expand button", () => {
  const bigContent = "line\n".repeat(30);
  const ctx = createCtx();
  const result = renderToolResult({ type: "tool_result", content: bigContent }, ctx);
  assertEquals(result!.components !== undefined, true);
  assertEquals(ctx.expandableContent.size, 1);
});

// --- renderThinking ---

Deno.test("renderThinking: short content returns single embed", () => {
  const results = renderThinking({ type: "thinking", content: "Let me think..." });
  assertEquals(results.length, 1);
  assertEquals(results[0].embeds![0].title, "💭 Thinking");
  assertEquals(results[0].embeds![0].color, 0x9b59b6);
});

Deno.test("renderThinking: long content splits with pagination labels", () => {
  const longThinking = "x".repeat(8000);
  const results = renderThinking({ type: "thinking", content: longThinking });
  assertEquals(results.length, 2);
  assertEquals(results[0].embeds![0].title, "💭 Thinking (1/2)");
  assertEquals(results[1].embeds![0].title, "💭 Thinking (2/2)");
});

// --- renderSystem ---

Deno.test("renderSystem: completion shows green with cost/duration", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: {
      subtype: "completion",
      session_id: "sess-1",
      total_cost_usd: 0.0123,
      duration_ms: 5400,
      model: "claude-sonnet-4-6",
    },
  };
  const ctx = createCtx();
  const result = renderSystem(msg, ctx);
  assertEquals(result.embeds![0].color, 0x00ff00);
  assertEquals(result.embeds![0].title, "✅ Claude Code Complete");
  const fields = result.embeds![0].fields!;
  const costField = fields.find((f) => f.name === "Cost");
  assertEquals(costField !== undefined, true);
  assertEquals(costField!.value.includes("0.0123"), true);
});

Deno.test("renderSystem: non-completion shows grey", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: { subtype: "init" },
  };
  const result = renderSystem(msg, createCtx());
  assertEquals(result.embeds![0].color, 0xaaaaaa);
  assertEquals(result.embeds![0].title, "⚙️ System: init");
});

Deno.test("renderSystem: sets currentSessionId from metadata", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: { subtype: "init", session_id: "new-sess" },
  };
  const ctx = createCtx();
  renderSystem(msg, ctx);
  assertEquals(ctx.currentSessionId, "new-sess");
});

Deno.test("renderSystem: completion outside thread shows action buttons", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: { subtype: "completion", session_id: "sess-1", total_cost_usd: 0.01, duration_ms: 100 },
  };
  const ctx = createCtx({ isThread: false });
  const result = renderSystem(msg, ctx);
  assertEquals(result.components !== undefined, true);
});

Deno.test("renderSystem: completion inside thread omits action buttons", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: { subtype: "completion", session_id: "sess-1", total_cost_usd: 0.01, duration_ms: 100 },
  };
  const ctx = createCtx({ isThread: true });
  const result = renderSystem(msg, ctx);
  assertEquals(result.components, undefined);
});

Deno.test("renderSystem: shutdown shows red with signal info", () => {
  const msg: ClaudeMessage = {
    type: "system",
    content: "",
    metadata: {
      subtype: "shutdown",
      signal: "SIGTERM",
      categoryName: "proj",
      repoName: "repo",
      branchName: "main",
    },
  };
  const result = renderSystem(msg, createCtx());
  assertEquals(result.embeds![0].color, 0xff0000);
  assertEquals(result.embeds![0].title, "🛑 Shutdown");
});

// --- renderOther ---

Deno.test("renderOther: renders metadata as JSON embed", () => {
  const msg: ClaudeMessage = {
    type: "other",
    content: "raw",
    metadata: { key: "value" },
  };
  const results = renderOther(msg);
  assertEquals(results.length, 1);
  assertEquals(results[0].embeds![0].title, "Other Content");
  assertEquals(results[0].embeds![0].description!.includes('"key"'), true);
});

Deno.test("renderOther: falls back to content when no metadata", () => {
  const msg: ClaudeMessage = { type: "other", content: "fallback text" };
  const results = renderOther(msg);
  assertEquals(results[0].embeds![0].description!.includes("fallback text"), true);
});

// --- renderPermissionDenied ---

Deno.test("renderPermissionDenied: shows tool name and input preview", () => {
  const msg: ClaudeMessage = {
    type: "permission_denied",
    content: "",
    metadata: { toolName: "Bash", toolInput: { command: "rm -rf /" } },
  };
  const result = renderPermissionDenied(msg);
  assertEquals(result.embeds![0].color, 0xff4444);
  assertEquals(result.embeds![0].title, "🚫 Permission Denied: Bash");
  assertEquals(result.embeds![0].fields![0].value, "`Bash`");
  assertEquals(result.embeds![0].fields![1].value.includes("rm -rf"), true);
});

// --- renderTaskStarted ---

Deno.test("renderTaskStarted: shows description and task type", () => {
  const msg: ClaudeMessage = {
    type: "task_started",
    content: "Analyzing code",
    metadata: { description: "Running analysis", taskType: "background" },
  };
  const result = renderTaskStarted(msg);
  assertEquals(result.embeds![0].title, "🚀 Subagent Task Started");
  assertEquals(result.embeds![0].description, "Running analysis");
  assertEquals(result.embeds![0].fields![0].value, "background");
});

Deno.test("renderTaskStarted: no taskType means no fields", () => {
  const msg: ClaudeMessage = {
    type: "task_started",
    content: "go",
    metadata: { description: "go" },
  };
  const result = renderTaskStarted(msg);
  assertEquals(result.embeds![0].fields!.length, 0);
});

// --- renderTaskNotification ---

Deno.test("renderTaskNotification: completed shows green", () => {
  const msg: ClaudeMessage = {
    type: "task_notification",
    content: "Done",
    metadata: { status: "completed", summary: "All good" },
  };
  const result = renderTaskNotification(msg);
  assertEquals(result.embeds![0].color, 0x00ff00);
  assertEquals(result.embeds![0].title!.includes("Completed"), true);
});

Deno.test("renderTaskNotification: failed shows red", () => {
  const msg: ClaudeMessage = {
    type: "task_notification",
    content: "",
    metadata: { status: "failed", summary: "Error occurred" },
  };
  const result = renderTaskNotification(msg);
  assertEquals(result.embeds![0].color, 0xff0000);
  assertEquals(result.embeds![0].title!.includes("Failed"), true);
});

Deno.test("renderTaskNotification: unknown status shows yellow", () => {
  const msg: ClaudeMessage = {
    type: "task_notification",
    content: "",
    metadata: { status: "cancelled", summary: "Cancelled" },
  };
  const result = renderTaskNotification(msg);
  assertEquals(result.embeds![0].color, 0xffaa00);
});

// --- renderToolProgress ---

Deno.test("renderToolProgress: returns null if elapsed < 5s", () => {
  const msg: ClaudeMessage = {
    type: "tool_progress",
    content: "",
    metadata: { toolName: "Bash", elapsedSeconds: 3 },
  };
  assertEquals(renderToolProgress(msg), null);
});

Deno.test("renderToolProgress: returns embed if elapsed >= 5s", () => {
  const msg: ClaudeMessage = {
    type: "tool_progress",
    content: "",
    metadata: { toolName: "Bash", elapsedSeconds: 12.3 },
  };
  const result = renderToolProgress(msg);
  assertEquals(result !== null, true);
  assertEquals(result!.embeds![0].title, "⏳ Bash running...");
  assertEquals(result!.embeds![0].description, "Elapsed: 12.3s");
});

// --- renderToolSummary ---

Deno.test("renderToolSummary: renders summary content", () => {
  const msg: ClaudeMessage = { type: "tool_summary", content: "Read 3 files" };
  const result = renderToolSummary(msg);
  assertEquals(result !== null, true);
  assertEquals(result!.embeds![0].title, "📋 Tool Summary");
  assertEquals(result!.embeds![0].description, "Read 3 files");
});

Deno.test("renderToolSummary: returns null for empty content", () => {
  const msg: ClaudeMessage = { type: "tool_summary", content: "" };
  assertEquals(renderToolSummary(msg), null);
});

Deno.test("renderToolSummary: truncates very long content", () => {
  const msg: ClaudeMessage = { type: "tool_summary", content: "x".repeat(5000) };
  const result = renderToolSummary(msg);
  assertEquals(result!.embeds![0].description!.length, 4000);
  assertEquals(result!.embeds![0].description!.endsWith("..."), true);
});
