import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { convertToClaudeMessages } from "./message-converter.ts";

// --- assistant messages ---

Deno.test("assistant: extracts text content", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "hello world" }],
    },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "text");
  assertEquals(msgs[0].content, "hello world");
});

Deno.test("assistant: joins multiple text blocks", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].content, "part1part2");
});

Deno.test("assistant: skips empty text content", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "" }],
    },
  });
  assertEquals(msgs.length, 0);
});

Deno.test("assistant: extracts tool_use messages", () => {
  const toolBlock = { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } };
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: { content: [toolBlock] },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "tool_use");
  assertEquals(msgs[0].content, "");
  assertEquals(msgs[0].metadata, toolBlock);
});

Deno.test("assistant: extracts multiple tool_use messages separately", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "tool_use", id: "t2", name: "Edit", input: {} },
      ],
    },
  });
  assertEquals(msgs.length, 2);
  assertEquals(msgs[0].metadata.name, "Read");
  assertEquals(msgs[1].metadata.name, "Edit");
});

Deno.test("assistant: extracts thinking content", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [{ type: "thinking", thinking: "let me think..." }],
    },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "thinking");
  assertEquals(msgs[0].content, "let me think...");
});

Deno.test("assistant: skips thinking block with empty thinking field", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [{ type: "thinking", thinking: "" }],
    },
  });
  assertEquals(msgs.length, 0);
});

Deno.test("assistant: handles mixed content types", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ],
    },
  });
  assertEquals(msgs.length, 3);
  assertEquals(msgs[0].type, "text");
  assertEquals(msgs[1].type, "tool_use");
  assertEquals(msgs[2].type, "thinking");
});

Deno.test("assistant: unknown content types become 'other'", () => {
  const msgs = convertToClaudeMessages({
    type: "assistant",
    message: {
      content: [{ type: "image", source: { data: "abc" } }],
    },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "other");
  assertEquals(msgs[0].content.includes('"image"'), true);
});

Deno.test("assistant: no message.content returns empty", () => {
  const msgs = convertToClaudeMessages({ type: "assistant", message: {} });
  assertEquals(msgs.length, 0);
});

// --- user messages (tool_result) ---

Deno.test("user: extracts tool_result with string content", () => {
  const msgs = convertToClaudeMessages({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: "output text" }],
    },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "tool_result");
  assertEquals(msgs[0].content, "output text");
});

Deno.test("user: extracts tool_result with array content", () => {
  const msgs = convertToClaudeMessages({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      }],
    },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].content, "line1\nline2");
});

Deno.test("user: tool_result with non-text blocks in array filters them out", () => {
  const msgs = convertToClaudeMessages({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "visible" },
          { type: "image", source: {} },
        ],
      }],
    },
  });
  assertEquals(msgs[0].content, "visible");
});

Deno.test("user: tool_result with null/object content falls back to JSON", () => {
  const msgs = convertToClaudeMessages({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: null }],
    },
  });
  assertEquals(msgs[0].type, "tool_result");
  assertEquals(msgs[0].content.includes("tool_result"), true);
});

Deno.test("user: non-tool_result content becomes 'other'", () => {
  const msgs = convertToClaudeMessages({
    type: "user",
    message: {
      content: [{ type: "text", text: "user input" }],
    },
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "other");
});

// --- result messages ---

Deno.test("result: success subtype becomes system completion", () => {
  const msgs = convertToClaudeMessages({
    type: "result",
    subtype: "success",
    cost_usd: 0.05,
    duration_ms: 1200,
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "system");
  assertEquals(msgs[0].metadata.subtype, "completion");
  assertEquals(msgs[0].metadata.sdkSubtype, "success");
});

Deno.test("result: error subtype becomes system error", () => {
  const msgs = convertToClaudeMessages({
    type: "result",
    subtype: "error_max_turns",
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].metadata.subtype, "error");
  assertEquals(msgs[0].metadata.sdkSubtype, "error_max_turns");
});

Deno.test("result: permission_denials are surfaced", () => {
  const msgs = convertToClaudeMessages({
    type: "result",
    subtype: "success",
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm -rf" } },
    ],
  });
  assertEquals(msgs.length, 2);
  assertEquals(msgs[0].type, "permission_denied");
  assertEquals(msgs[0].metadata.toolName, "Bash");
  assertEquals(msgs[1].type, "system");
});

Deno.test("result: duplicate permission_denials are deduplicated", () => {
  const msgs = convertToClaudeMessages({
    type: "result",
    subtype: "success",
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "t1", tool_input: {} },
      { tool_name: "Bash", tool_use_id: "t2", tool_input: {} },
      { tool_name: "Edit", tool_use_id: "t3", tool_input: {} },
    ],
  });
  const denials = msgs.filter((m) => m.type === "permission_denied");
  assertEquals(denials.length, 2);
  assertEquals(denials[0].metadata.toolName, "Bash");
  assertEquals(denials[1].metadata.toolName, "Edit");
});

Deno.test("result: empty permission_denials array does not produce denial messages", () => {
  const msgs = convertToClaudeMessages({
    type: "result",
    subtype: "success",
    permission_denials: [],
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "system");
});

// --- system messages ---

Deno.test("system: task_notification", () => {
  const msgs = convertToClaudeMessages({
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    status: "completed",
    output_file: "/tmp/out.txt",
    summary: "Done processing",
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "task_notification");
  assertEquals(msgs[0].content, "Done processing");
  assertEquals(msgs[0].metadata.taskId, "task-1");
  assertEquals(msgs[0].metadata.status, "completed");
});

Deno.test("system: task_started", () => {
  const msgs = convertToClaudeMessages({
    type: "system",
    subtype: "task_started",
    task_id: "task-2",
    description: "Running analysis",
    task_type: "background",
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "task_started");
  assertEquals(msgs[0].content, "Running analysis");
  assertEquals(msgs[0].metadata.taskId, "task-2");
});

Deno.test("system: generic system message", () => {
  const msgs = convertToClaudeMessages({
    type: "system",
    subtype: "init",
    session_id: "s-123",
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "system");
  assertEquals(msgs[0].metadata.subtype, "init");
});

// --- tool_progress ---

Deno.test("tool_progress: maps fields correctly", () => {
  const msgs = convertToClaudeMessages({
    type: "tool_progress",
    tool_use_id: "tu-1",
    tool_name: "Bash",
    elapsed_time_seconds: 12.5,
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "tool_progress");
  assertEquals(msgs[0].content, "Bash: 12.5s");
  assertEquals(msgs[0].metadata.toolName, "Bash");
  assertEquals(msgs[0].metadata.elapsedSeconds, 12.5);
});

// --- tool_use_summary ---

Deno.test("tool_use_summary: maps to tool_summary type", () => {
  const msgs = convertToClaudeMessages({
    type: "tool_use_summary",
    summary: "Read 3 files",
    preceding_tool_use_ids: ["t1", "t2", "t3"],
  });
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].type, "tool_summary");
  assertEquals(msgs[0].content, "Read 3 files");
  assertEquals(msgs[0].metadata.toolUseIds, ["t1", "t2", "t3"]);
});

// --- unknown message types ---

Deno.test("unknown type: returns empty array", () => {
  const msgs = convertToClaudeMessages({ type: "unknown_future_type", data: {} });
  assertEquals(msgs.length, 0);
});

Deno.test("empty object: returns empty array", () => {
  const msgs = convertToClaudeMessages({});
  assertEquals(msgs.length, 0);
});
