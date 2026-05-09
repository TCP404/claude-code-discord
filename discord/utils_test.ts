import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { sanitizeChannelName, splitText } from "./utils.ts";

// --- sanitizeChannelName ---

Deno.test("sanitizeChannelName: lowercases and replaces invalid chars", () => {
  assertEquals(sanitizeChannelName("Hello World!"), "hello-world");
});

Deno.test("sanitizeChannelName: collapses consecutive dashes", () => {
  assertEquals(sanitizeChannelName("a---b"), "a-b");
});

Deno.test("sanitizeChannelName: strips leading/trailing dashes", () => {
  assertEquals(sanitizeChannelName("--hello--"), "hello");
});

Deno.test("sanitizeChannelName: preserves valid chars (lowercase, digits, dash, underscore)", () => {
  assertEquals(sanitizeChannelName("my_channel-123"), "my_channel-123");
});

Deno.test("sanitizeChannelName: truncates to 100 chars", () => {
  const long = "a".repeat(150);
  assertEquals(sanitizeChannelName(long).length, 100);
});

Deno.test("sanitizeChannelName: empty string returns empty", () => {
  assertEquals(sanitizeChannelName(""), "");
});

Deno.test("sanitizeChannelName: unicode becomes dashes then collapses", () => {
  assertEquals(sanitizeChannelName("项目-alpha"), "alpha");
});

// --- splitText ---

Deno.test("splitText: returns single chunk when under limit", () => {
  assertEquals(splitText("hello", 10), ["hello"]);
});

Deno.test("splitText: splits at exact boundary", () => {
  assertEquals(splitText("abcdef", 3), ["abc", "def"]);
});

Deno.test("splitText: handles empty string", () => {
  assertEquals(splitText("", 5), []);
});

Deno.test("splitText: each chunk respects maxLength", () => {
  const chunks = splitText("a".repeat(10), 3);
  for (const chunk of chunks) {
    assertEquals(chunk.length <= 3, true);
  }
  assertEquals(chunks.join(""), "a".repeat(10));
});

Deno.test("splitText: handles unicode code points without breaking them", () => {
  const emoji = "😀😀😀";
  const chunks = splitText(emoji, 2);
  for (const chunk of chunks) {
    assertEquals(chunk.length <= 2, true);
  }
  assertEquals(chunks.join(""), emoji);
});

Deno.test("splitText: single character longer than maxLength still produces output", () => {
  const chunks = splitText("😀", 1);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0], "😀");
});
