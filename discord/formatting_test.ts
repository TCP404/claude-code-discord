import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createFormattedEmbed,
  formatError,
  formatFileContent,
  formatGitOutput,
  formatShellOutput,
  formatText,
  needsFormatting,
} from "./formatting.ts";

// --- formatText ---

Deno.test("formatText: returns unmodified short text", () => {
  const result = formatText("hello");
  assertEquals(result.formatted, "hello");
  assertEquals(result.wasTruncated, false);
  assertEquals(result.originalLength, 5);
});

Deno.test("formatText: truncates long text", () => {
  const long = "x".repeat(5000);
  const result = formatText(long, { maxLength: 4000, truncateAt: 3800 });
  assertEquals(result.wasTruncated, true);
  assertEquals(result.formatted.length <= 3820, true);
  assertEquals(result.formatted.endsWith("... (truncated)"), true);
});

Deno.test("formatText: adds line numbers", () => {
  const result = formatText("a\nb\nc", { showLineNumbers: true });
  assertEquals(result.formatted.includes("  1"), true);
  assertEquals(result.formatted.includes("  2"), true);
  assertEquals(result.formatted.includes("  3"), true);
});

Deno.test("formatText: highlights specified lines", () => {
  const result = formatText("a\nb\nc", { showLineNumbers: true, highlightLines: [2] });
  const lines = result.formatted.split("\n");
  assertEquals(lines[1].includes("►"), true);
  assertEquals(lines[0].includes("►"), false);
});

Deno.test("formatText: wraps in code block", () => {
  const result = formatText("code", { wrapInCodeBlock: true, language: "ts" });
  assertEquals(result.formatted, "```ts\ncode\n```");
});

Deno.test("formatText: code block with no language", () => {
  const result = formatText("code", { wrapInCodeBlock: true });
  assertEquals(result.formatted, "```\ncode\n```");
});

Deno.test("formatText: empty string", () => {
  const result = formatText("");
  assertEquals(result.formatted, "");
  assertEquals(result.wasTruncated, false);
});

// --- formatFileContent ---

Deno.test("formatFileContent: detects TypeScript", () => {
  const result = formatFileContent("app.ts", "const x = 1;");
  assertEquals(result.language, "typescript");
  assertEquals(result.fileType, "TypeScript");
  assertEquals(result.formatted.startsWith("```typescript"), true);
});

Deno.test("formatFileContent: detects Python", () => {
  const result = formatFileContent("main.py", "print('hi')");
  assertEquals(result.language, "python");
  assertEquals(result.fileType, "Python");
});

Deno.test("formatFileContent: unknown extension defaults to text", () => {
  const result = formatFileContent("data.xyz", "stuff");
  assertEquals(result.language, "text");
  assertEquals(result.fileType, "Text File");
});

Deno.test("formatFileContent: truncates large content", () => {
  const big = "line\n".repeat(2000);
  const result = formatFileContent("big.ts", big, { maxLength: 500, truncateAt: 400 });
  assertEquals(result.wasTruncated, true);
});

// --- formatShellOutput ---

Deno.test("formatShellOutput: formats successful command", () => {
  const result = formatShellOutput("ls", "file1\nfile2", 0);
  assertEquals(result.isError, false);
  assertEquals(result.formatted.includes("$ ls"), true);
  assertEquals(result.formatted.includes("file1"), true);
});

Deno.test("formatShellOutput: marks non-zero exit as error", () => {
  const result = formatShellOutput("bad-cmd", "not found", 1);
  assertEquals(result.isError, true);
});

Deno.test("formatShellOutput: strips ANSI codes", () => {
  const result = formatShellOutput("ls", "\x1b[32mgreen\x1b[0m text", 0);
  assertEquals(result.formatted.includes("\x1b"), false);
  assertEquals(result.formatted.includes("green"), true);
});

Deno.test("formatShellOutput: normalizes line endings", () => {
  const result = formatShellOutput("cmd", "a\r\nb\rc", 0);
  assertEquals(result.formatted.includes("\r"), false);
});

Deno.test("formatShellOutput: skips command prefix for long commands", () => {
  const longCmd = "x".repeat(150);
  const result = formatShellOutput(longCmd, "output", 0);
  assertEquals(result.formatted.includes("$ " + longCmd), false);
});

// --- formatGitOutput ---

Deno.test("formatGitOutput: detects status command", () => {
  const result = formatGitOutput("status", "On branch main");
  assertEquals(result.outputType, "status");
});

Deno.test("formatGitOutput: detects diff command with diff language", () => {
  const result = formatGitOutput("diff HEAD", "+added\n-removed");
  assertEquals(result.outputType, "diff");
  assertEquals(result.formatted.includes("```diff"), true);
});

Deno.test("formatGitOutput: detects log command", () => {
  const result = formatGitOutput("log --oneline", "abc123 msg");
  assertEquals(result.outputType, "log");
});

Deno.test("formatGitOutput: detects branch command", () => {
  const result = formatGitOutput("branch -a", "* main\n  dev");
  assertEquals(result.outputType, "branch");
});

Deno.test("formatGitOutput: detects error in output", () => {
  const result = formatGitOutput("push", "fatal: remote rejected");
  assertEquals(result.isError, true);
});

Deno.test("formatGitOutput: non-error output", () => {
  const result = formatGitOutput("status", "nothing to commit");
  assertEquals(result.isError, false);
});

// --- formatError ---

Deno.test("formatError: formats string error", () => {
  const result = formatError("something broke");
  assertEquals(result.formatted.includes("something broke"), true);
  assertEquals(result.errorType, "Generic Error");
});

Deno.test("formatError: detects ENOENT", () => {
  const result = formatError("ENOENT: no such file");
  assertEquals(result.errorType, "File Not Found");
});

Deno.test("formatError: detects EACCES", () => {
  const result = formatError("EACCES: permission denied");
  assertEquals(result.errorType, "Permission Denied");
});

Deno.test("formatError: detects ECONNREFUSED", () => {
  const result = formatError("ECONNREFUSED 127.0.0.1:3000");
  assertEquals(result.errorType, "Connection Refused");
});

Deno.test("formatError: detects timeout", () => {
  const result = formatError("request timeout after 30s");
  assertEquals(result.errorType, "Timeout Error");
});

Deno.test("formatError: includes context when provided", () => {
  const result = formatError("fail", "during init");
  assertEquals(result.formatted.includes("Context: during init"), true);
});

Deno.test("formatError: handles Error object with stack", () => {
  const err = new Error("test error");
  const result = formatError(err);
  assertEquals(result.formatted.includes("test error"), true);
  assertEquals(result.formatted.includes("Stack Trace"), true);
});

Deno.test("formatError: TypeError gets correct errorType", () => {
  const err = new TypeError("bad type");
  const result = formatError(err);
  assertEquals(result.errorType, "TypeError");
});

// --- needsFormatting ---

Deno.test("needsFormatting: short plain text does not need code block", () => {
  const result = needsFormatting("hi");
  assertEquals(result.needsCodeBlock, false);
  assertEquals(result.contentType, "text");
});

Deno.test("needsFormatting: long text needs code block", () => {
  const result = needsFormatting("x".repeat(60));
  assertEquals(result.needsCodeBlock, true);
});

Deno.test("needsFormatting: code patterns detected", () => {
  const result = needsFormatting("import foo from 'bar';\nconst x = 1;");
  assertEquals(result.contentType, "code");
  assertEquals(result.needsCodeBlock, true);
});

Deno.test("needsFormatting: log patterns detected", () => {
  const result = needsFormatting("2024-01-15 ERROR something\n2024-01-15 INFO ok");
  assertEquals(result.contentType, "log");
  assertEquals(result.suggestedLanguage, "log");
});

Deno.test("needsFormatting: JSON object starting with { detected as code (ambiguous)", () => {
  const result = needsFormatting('{"key": "value"}');
  assertEquals(result.needsCodeBlock, true);
  assertEquals(result.contentType, "code");
});

// --- createFormattedEmbed ---

Deno.test("createFormattedEmbed: creates embed with auto-detection", () => {
  const result = createFormattedEmbed("Title", "short text", 0xff0000);
  assertEquals(result.embed.title, "Title");
  assertEquals(result.embed.color, 0xff0000);
  assertEquals(result.wasTruncated, false);
});

Deno.test("createFormattedEmbed: adds footer when truncated", () => {
  const long = "x".repeat(5000);
  const result = createFormattedEmbed("Big", long);
  assertEquals(result.wasTruncated, true);
  assertEquals(result.embed.footer !== undefined, true);
});
