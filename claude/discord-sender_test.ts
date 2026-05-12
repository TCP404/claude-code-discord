import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClaudeSender } from "./discord-sender.ts";
import type { DiscordSender, TrackedMessage } from "./types.ts";
import type { MessageContent } from "../discord/types.ts";

interface MockTracked {
  content: MessageContent;
  edited: MessageContent[];
  deleted: boolean;
}

interface MockSender {
  sender: DiscordSender;
  sent: MessageContent[];
  tracked: MockTracked[];
}

function createMockSender(): MockSender {
  const sent: MessageContent[] = [];
  const tracked: MockTracked[] = [];

  const sender: DiscordSender = {
    // deno-lint-ignore require-await
    sendMessage: async (content: MessageContent) => {
      sent.push(content);
    },
    // deno-lint-ignore require-await
    sendTracked: async (content: MessageContent) => {
      const t: MockTracked = { content, edited: [], deleted: false };
      tracked.push(t);
      const msg: TrackedMessage = {
        // deno-lint-ignore require-await
        edit: async (c: MessageContent) => {
          t.edited.push(c);
        },
        // deno-lint-ignore require-await
        delete: async () => {
          t.deleted = true;
        },
      };
      return msg;
    },
  };

  return { sender, sent, tracked };
}

// --- Basic dispatch to renderers ---

Deno.test("discord-sender: text message dispatches to sendMessage", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{ type: "text", content: "hello" }]);
  assertEquals(mock.sent.length, 1);
  assertEquals(mock.sent[0].content, "hello");
});

Deno.test("discord-sender: thinking message dispatches visible embed", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{ type: "thinking", content: "hmm" }]);
  assertEquals(mock.sent.length, 1);
  assertEquals(mock.sent[0].embeds![0].title, "💭 Thinking");
});

Deno.test("discord-sender: permission_denied dispatches visible embed", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{
    type: "permission_denied",
    content: "",
    metadata: { toolName: "Bash", toolInput: {} },
  }]);
  assertEquals(mock.sent.length, 1);
  assertEquals(mock.sent[0].embeds![0].title!.includes("Permission Denied"), true);
});

// --- Hidden messages go to status line ---

Deno.test("discord-sender: tool_use is hidden by default and updates status", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{
    type: "tool_use",
    content: "",
    metadata: { name: "Bash", input: { command: "ls" } },
  }]);
  // Should NOT appear in regular sent messages
  assertEquals(mock.sent.length, 0);
  // Should create a tracked status message
  assertEquals(mock.tracked.length, 1);
  assertEquals(mock.tracked[0].content.content!.includes("Running"), true);
});

Deno.test("discord-sender: tool_result is hidden by default", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{ type: "tool_result", content: "output" }]);
  assertEquals(mock.sent.length, 0);
});

Deno.test("discord-sender: system init is hidden by default", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{
    type: "system",
    content: "",
    metadata: { subtype: "init" },
  }]);
  assertEquals(mock.sent.length, 0);
  assertEquals(mock.tracked.length, 1);
});

// --- Status line edits on consecutive hidden messages ---

Deno.test("discord-sender: consecutive hidden messages edit existing status", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([
    { type: "tool_use", content: "", metadata: { name: "Read", input: { file_path: "/a.ts" } } },
    { type: "tool_use", content: "", metadata: { name: "Read", input: { file_path: "/b.ts" } } },
  ]);
  // First creates tracked, second edits it
  assertEquals(mock.tracked.length, 1);
  assertEquals(mock.tracked[0].edited.length, 1);
});

// --- Status line repositions after visible message ---

Deno.test("discord-sender: status line repositions after visible message interrupts", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);

  // Hidden → creates status
  await cs.send([
    { type: "tool_use", content: "", metadata: { name: "Read", input: { file_path: "/a.ts" } } },
  ]);
  assertEquals(mock.tracked.length, 1);

  // Visible → marks visibleSentSinceStatus = true
  await cs.send([{ type: "text", content: "result" }]);
  assertEquals(mock.sent.length, 1);

  // Another hidden → should delete old status and create new one
  await cs.send([
    { type: "tool_use", content: "", metadata: { name: "Edit", input: { file_path: "/b.ts" } } },
  ]);
  assertEquals(mock.tracked[0].deleted, true);
  assertEquals(mock.tracked.length, 2);
});

// --- Completion finalization ---

Deno.test("discord-sender: hidden completion with cost finalizes status line", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender, { sessionId: "sess-1" });

  // Create initial status
  await cs.send([
    { type: "tool_use", content: "", metadata: { name: "Bash", input: { command: "test" } } },
  ]);

  // Completion (hidden by default)
  await cs.send([{
    type: "system",
    content: "",
    metadata: {
      subtype: "completion",
      total_cost_usd: 0.05,
      duration_ms: 3000,
      session_id: "sess-1",
    },
  }]);

  // Status message should have been edited to show cost
  const lastTracked = mock.tracked[0];
  assertEquals(lastTracked.edited.length >= 1, true);
  const lastEdit = lastTracked.edited[lastTracked.edited.length - 1];
  assertEquals(lastEdit.content!.includes("✅"), true);
  assertEquals(lastEdit.content!.includes("0.0500"), true);
});

Deno.test("discord-sender: hidden completion without cost clears status", async () => {
  const mock = createMockSender();
  // Set SHOW_COST=false to trigger clearStatus path
  const origShowCost = Deno.env.get("SHOW_COST");
  Deno.env.set("SHOW_COST", "false");
  try {
    const cs = createClaudeSender(mock.sender);
    await cs.send([
      { type: "tool_use", content: "", metadata: { name: "Bash", input: { command: "x" } } },
    ]);
    await cs.send([{
      type: "system",
      content: "",
      metadata: { subtype: "completion", total_cost_usd: 0.01, duration_ms: 100 },
    }]);
    assertEquals(mock.tracked[0].deleted, true);
  } finally {
    if (origShowCost !== undefined) Deno.env.set("SHOW_COST", origShowCost);
    else Deno.env.delete("SHOW_COST");
  }
});

// --- Visible system completion (when system:completion is not hidden) ---

Deno.test("discord-sender: visible system completion clears status and sends embed", async () => {
  const mock = createMockSender();
  const { hiddenMessageTypes } = await import("./sender-utils.ts");

  // Temporarily make system:completion visible
  hiddenMessageTypes.delete("system:completion");
  try {
    const cs = createClaudeSender(mock.sender, { sessionId: "sess-1" });
    await cs.send([
      { type: "tool_use", content: "", metadata: { name: "Bash", input: { command: "x" } } },
    ]);
    await cs.send([{
      type: "system",
      content: "",
      metadata: {
        subtype: "completion",
        session_id: "sess-1",
        total_cost_usd: 0.02,
        duration_ms: 500,
      },
    }]);
    // Status should be deleted
    assertEquals(mock.tracked[0].deleted, true);
    // System embed should be sent as visible
    assertEquals(mock.sent.length >= 1, true);
    assertEquals(mock.sent[mock.sent.length - 1].embeds![0].title, "✅ Claude Code Complete");
  } finally {
    hiddenMessageTypes.add("system:completion");
  }
});

// --- setSessionId ---

Deno.test("discord-sender: setSessionId updates session for cost tracking", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  cs.setSessionId("new-session");

  await cs.send([{
    type: "system",
    content: "",
    metadata: {
      subtype: "completion",
      total_cost_usd: 0.01,
      duration_ms: 100,
      session_id: "new-session",
    },
  }]);

  // Should finalize with cost (the status line shows it)
  // Since no prior status exists, it creates a new tracked message
  assertEquals(mock.tracked.length, 1);
  assertEquals(mock.tracked[0].content.content!.includes("0.0100"), true);
});

// --- No sendTracked (plain sender without tracking) ---

Deno.test("discord-sender: works without sendTracked (no status line)", async () => {
  const sent: MessageContent[] = [];
  const plainSender: DiscordSender = {
    // deno-lint-ignore require-await
    sendMessage: async (content: MessageContent) => {
      sent.push(content);
    },
  };
  const cs = createClaudeSender(plainSender);

  await cs.send([
    { type: "tool_use", content: "", metadata: { name: "Bash", input: { command: "ls" } } },
    { type: "text", content: "visible" },
  ]);

  // Hidden messages silently ignored, visible still sent
  assertEquals(sent.length, 1);
  assertEquals(sent[0].content, "visible");
});

// --- Multiple message types in sequence ---

Deno.test("discord-sender: mixed message sequence dispatches correctly", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);

  await cs.send([
    { type: "tool_use", content: "", metadata: { name: "Bash", input: { command: "ls" } } },
    { type: "tool_result", content: "file1" },
    { type: "text", content: "Here are the files" },
    { type: "tool_use", content: "", metadata: { name: "Read", input: { file_path: "/x" } } },
    { type: "tool_result", content: "content" },
    { type: "text", content: "Done" },
  ]);

  // Only text messages are visible (tool_use and tool_result are hidden)
  assertEquals(mock.sent.length, 2);
  assertEquals(mock.sent[0].content, "Here are the files");
  assertEquals(mock.sent[1].content, "Done");
});

// --- task_started and task_notification dispatch ---

Deno.test("discord-sender: task_started sends visible embed", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{
    type: "task_started",
    content: "Running",
    metadata: { description: "Analysis", taskType: "bg" },
  }]);
  assertEquals(mock.sent.length, 1);
  assertEquals(mock.sent[0].embeds![0].title, "🚀 Subagent Task Started");
});

Deno.test("discord-sender: task_notification sends visible embed", async () => {
  const mock = createMockSender();
  const cs = createClaudeSender(mock.sender);
  await cs.send([{
    type: "task_notification",
    content: "",
    metadata: { status: "completed", summary: "All done" },
  }]);
  assertEquals(mock.sent.length, 1);
  assertEquals(mock.sent[0].embeds![0].title!.includes("Completed"), true);
});

// --- tool_progress visible behavior ---

Deno.test("discord-sender: tool_progress with elapsed >= 5s sends visible when not hidden", async () => {
  const mock = createMockSender();
  const { hiddenMessageTypes } = await import("./sender-utils.ts");
  hiddenMessageTypes.delete("tool_progress");
  try {
    const cs = createClaudeSender(mock.sender);
    await cs.send([{
      type: "tool_progress",
      content: "Bash: 10s",
      metadata: { toolName: "Bash", elapsedSeconds: 10 },
    }]);
    assertEquals(mock.sent.length, 1);
    assertEquals(mock.sent[0].embeds![0].title, "⏳ Bash running...");
  } finally {
    hiddenMessageTypes.add("tool_progress");
  }
});

Deno.test("discord-sender: tool_progress with elapsed < 5s sends nothing when visible", async () => {
  const mock = createMockSender();
  const { hiddenMessageTypes } = await import("./sender-utils.ts");
  hiddenMessageTypes.delete("tool_progress");
  try {
    const cs = createClaudeSender(mock.sender);
    await cs.send([{
      type: "tool_progress",
      content: "Bash: 2s",
      metadata: { toolName: "Bash", elapsedSeconds: 2 },
    }]);
    assertEquals(mock.sent.length, 0);
  } finally {
    hiddenMessageTypes.add("tool_progress");
  }
});
