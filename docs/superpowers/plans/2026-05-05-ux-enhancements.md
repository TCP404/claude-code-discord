# UX Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typing indicator, multi-type file preview, and session-level usage tracking to the Discord bot.

**Architecture:** Three independent features layered onto the existing streaming pipeline. Typing indicator hooks into the SDK iteration loop via callback. File preview replaces the current button-only detection with type-aware inline previews. Session usage adds a lightweight in-memory accumulator that enriches the completion embed.

**Tech Stack:** Deno, discord.js, @anthropic-ai/claude-agent-sdk (existing stack, no new deps)

---

## File Structure

| File | Role |
|------|------|
| `claude/session-usage.ts` | **New** — session usage accumulator (record, get, clear) |
| `claude/file-preview.ts` | **New** — file type detection + preview strategy dispatch |
| `claude/client.ts` | **Modify** — add `onTyping` callback, call `recordUsage()` |
| `claude/discord-sender.ts` | **Modify** — replace file button logic with `previewFile()`, enrich completion embed |
| `discord/types.ts` | **Modify** — add `files` field to `MessageContent` interface |
| `index.ts` | **Modify** — pass `onTyping` and `sessionId` to sender |

---

### Task 1: Session Usage Module

**Files:**
- Create: `claude/session-usage.ts`

- [ ] **Step 1: Create session-usage.ts**

```typescript
// claude/session-usage.ts

export interface SessionUsage {
  totalCost: number;
  totalDuration: number;
  queryCount: number;
}

const usageMap = new Map<string, SessionUsage>();

export function recordUsage(sessionId: string, cost: number, duration: number): SessionUsage {
  const existing = usageMap.get(sessionId);
  if (existing) {
    existing.totalCost += cost;
    existing.totalDuration += duration;
    existing.queryCount += 1;
    return existing;
  }
  const usage: SessionUsage = { totalCost: cost, totalDuration: duration, queryCount: 1 };
  usageMap.set(sessionId, usage);
  return usage;
}

export function getUsage(sessionId: string): SessionUsage | undefined {
  return usageMap.get(sessionId);
}

export function clearUsage(sessionId: string): void {
  usageMap.delete(sessionId);
}

export function clearAllUsage(): void {
  usageMap.clear();
}
```

- [ ] **Step 2: Type check**

Run: `npx deno check claude/session-usage.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add claude/session-usage.ts
git commit -m "feat: add session usage tracking module"
```

---

### Task 2: File Preview Module

**Files:**
- Create: `claude/file-preview.ts`

- [ ] **Step 1: Create file-preview.ts**

```typescript
// claude/file-preview.ts

import { existsSync } from "node:fs";
import { extname, basename } from "node:path";
import type { MessageContent } from "../discord/types.ts";

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const CODE_EXTS = ['ts', 'js', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'sql', 'json', 'yaml', 'yml', 'toml', 'md', 'html', 'css', 'rb', 'swift', 'kt'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CODE_SIZE = 100 * 1024; // 100KB
const MAX_CSV_SIZE = 50 * 1024; // 50KB
const CODE_PREVIEW_LINES = 20;
const CSV_PREVIEW_ROWS = 5;

export interface PreviewResult {
  type: 'inline_file' | 'embed' | 'button';
  content: MessageContent;
}

export async function generatePreview(filePath: string): Promise<PreviewResult | null> {
  if (!existsSync(filePath)) return null;

  const ext = extname(filePath).slice(1).toLowerCase();
  const fileName = basename(filePath);

  if (IMAGE_EXTS.includes(ext)) {
    return await previewImage(filePath, fileName);
  }
  if (ext === 'pdf') {
    return await previewPdf(filePath, fileName);
  }
  if (ext === 'csv') {
    return await previewCsv(filePath, fileName);
  }
  if (CODE_EXTS.includes(ext)) {
    return await previewCode(filePath, fileName, ext);
  }

  return null; // unsupported type — caller falls back to button
}

async function previewImage(filePath: string, fileName: string): Promise<PreviewResult | null> {
  try {
    const stat = await Deno.stat(filePath);
    if (stat.size > MAX_IMAGE_SIZE) return null; // too large, fallback to button
    return {
      type: 'inline_file',
      content: { files: [{ path: filePath, name: fileName }] }
    };
  } catch {
    return null;
  }
}

async function previewPdf(filePath: string, fileName: string): Promise<PreviewResult | null> {
  try {
    // Try to generate first-page preview via sips (macOS) or pdftoppm (Linux)
    const tmpPng = `/tmp/pdf-preview-${Date.now()}.png`;
    let success = false;

    if (Deno.build.os === 'darwin') {
      const cmd = new Deno.Command("sips", {
        args: ["-s", "format", "png", "--resampleWidth", "800", filePath, "--out", tmpPng],
        stdout: "null",
        stderr: "null",
      });
      const result = await cmd.output();
      success = result.success;
    } else {
      const cmd = new Deno.Command("pdftoppm", {
        args: ["-png", "-f", "1", "-l", "1", "-scale-to", "800", filePath, "/tmp/pdf-preview"],
        stdout: "null",
        stderr: "null",
      });
      const result = await cmd.output();
      if (result.success && existsSync("/tmp/pdf-preview-1.png")) {
        await Deno.rename("/tmp/pdf-preview-1.png", tmpPng);
        success = true;
      }
    }

    if (success && existsSync(tmpPng)) {
      return {
        type: 'inline_file',
        content: {
          content: `**PDF:** ${fileName}`,
          files: [{ path: tmpPng, name: `preview-${fileName}.png` }]
        }
      };
    }

    // Fallback: text-only info
    return {
      type: 'embed',
      content: {
        embeds: [{
          color: 0xe74c3c,
          title: `📄 ${fileName}`,
          description: 'PDF file (preview unavailable)',
          timestamp: true
        }]
      }
    };
  } catch {
    return null;
  }
}

async function previewCode(filePath: string, fileName: string, ext: string): Promise<PreviewResult | null> {
  try {
    const stat = await Deno.stat(filePath);
    if (stat.size > MAX_CODE_SIZE) return null; // too large

    const content = await Deno.readTextFile(filePath);
    const lines = content.split('\n');
    const previewLines = lines.slice(0, CODE_PREVIEW_LINES);
    const hasMore = lines.length > CODE_PREVIEW_LINES;

    const codeBlock = `\`\`\`${ext}\n${previewLines.join('\n')}\n\`\`\``;
    const header = hasMore
      ? `**${fileName}** (showing ${CODE_PREVIEW_LINES}/${lines.length} lines)`
      : `**${fileName}**`;

    return {
      type: 'embed',
      content: {
        embeds: [{
          color: 0x2b82d4,
          title: `📝 ${fileName}`,
          description: `${header}\n${codeBlock}`,
          timestamp: true
        }]
      }
    };
  } catch {
    return null;
  }
}

async function previewCsv(filePath: string, fileName: string): Promise<PreviewResult | null> {
  try {
    const stat = await Deno.stat(filePath);
    if (stat.size > MAX_CSV_SIZE) {
      // Large CSV: just show row count
      const content = await Deno.readTextFile(filePath);
      const totalLines = content.split('\n').filter(l => l.trim()).length;
      return {
        type: 'embed',
        content: {
          embeds: [{
            color: 0x27ae60,
            title: `📊 ${fileName}`,
            description: `CSV file with ~${totalLines - 1} data rows (too large for preview)`,
            timestamp: true
          }]
        }
      };
    }

    const content = await Deno.readTextFile(filePath);
    const lines = content.split('\n').filter(l => l.trim());
    const totalRows = lines.length - 1;
    const previewLines = lines.slice(0, CSV_PREVIEW_ROWS + 1); // header + N rows

    // Simple CSV to markdown table
    const table = csvToMarkdownTable(previewLines);
    const footer = totalRows > CSV_PREVIEW_ROWS
      ? `\n*...and ${totalRows - CSV_PREVIEW_ROWS} more rows*`
      : '';

    return {
      type: 'embed',
      content: {
        embeds: [{
          color: 0x27ae60,
          title: `📊 ${fileName} (${totalRows} rows)`,
          description: table + footer,
          timestamp: true
        }]
      }
    };
  } catch {
    return null;
  }
}

function csvToMarkdownTable(lines: string[]): string {
  if (lines.length === 0) return '';

  const rows = lines.map(line => parseCsvLine(line));
  if (rows.length === 0) return '';

  const header = rows[0];
  const separator = header.map(() => '---');
  const dataRows = rows.slice(1);

  const formatRow = (cells: string[]) => `| ${cells.join(' | ')} |`;

  const result = [
    formatRow(header),
    formatRow(separator),
    ...dataRows.map(formatRow)
  ];

  return result.join('\n');
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());

  // Truncate long cell values for display
  return cells.map(c => c.length > 30 ? c.slice(0, 27) + '...' : c);
}
```

- [ ] **Step 2: Type check**

Run: `npx deno check claude/file-preview.ts`
Expected: No errors (may need to verify `discord/types.ts` has `files` field — see Task 4)

- [ ] **Step 3: Commit**

```bash
git add claude/file-preview.ts
git commit -m "feat: add multi-type file preview module"
```

---

### Task 3: Add `files` field to MessageContent

**Files:**
- Modify: `discord/types.ts`

- [ ] **Step 1: Read current types.ts to find MessageContent interface**

Run: `grep -n "MessageContent" discord/types.ts`

- [ ] **Step 2: Add files field to MessageContent**

Add to the `MessageContent` interface:

```typescript
/** File attachments to upload inline */
files?: Array<{ path: string; name: string }>;
```

- [ ] **Step 3: Update sender implementation to handle files**

In the Discord bot layer (likely `discord/bot.ts` or wherever `sendMessage` is implemented), handle the new `files` field by creating `AttachmentBuilder` instances:

```typescript
import { AttachmentBuilder } from "npm:discord.js";

// Inside sendMessage implementation:
if (content.files?.length) {
  const attachments = content.files.map(f => new AttachmentBuilder(f.path, { name: f.name }));
  // Include in the message payload
  msgPayload.files = attachments;
}
```

- [ ] **Step 4: Type check**

Run: `npx deno check discord/types.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add discord/types.ts
git commit -m "feat: add files field to MessageContent interface"
```

---

### Task 4: Integrate Typing Indicator into client.ts

**Files:**
- Modify: `claude/client.ts`

- [ ] **Step 1: Add onTyping to sendToClaudeCode signature**

Find the `sendToClaudeCode` function signature (line ~157) and add `onTyping` parameter:

```typescript
export async function sendToClaudeCode(
  workDir: string,
  prompt: string,
  controller: AbortController,
  sessionId?: string,
  onChunk?: (text: string) => void,
  // deno-lint-ignore no-explicit-any
  onStreamJson?: (json: any) => void,
  continueMode?: boolean,
  modelOptions?: ClaudeModelOptions,
  onTyping?: () => void   // <-- ADD THIS
): Promise<{
```

- [ ] **Step 2: Add typing interval logic before SDK iteration loop**

Inside `executeWithErrorHandling`, right before `for await (const message of iterator)` (line ~341), add:

```typescript
// Typing indicator: fire immediately, then every 8s
let typingInterval: ReturnType<typeof setInterval> | undefined;
if (onTyping) {
  try { onTyping(); } catch { /* non-critical */ }
  typingInterval = setInterval(() => {
    try { onTyping(); } catch { /* non-critical */ }
  }, 8000);
}
```

- [ ] **Step 3: Clear typing interval in all exit paths**

After the `for await` loop ends (line ~385), add cleanup:

```typescript
clearInterval(typingInterval);
```

Also in the catch block (line ~398):

```typescript
clearInterval(typingInterval);
```

- [ ] **Step 4: Type check**

Run: `npx deno check claude/client.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add claude/client.ts
git commit -m "feat: add typing indicator callback to SDK query loop"
```

---

### Task 5: Integrate Session Usage into client.ts

**Files:**
- Modify: `claude/client.ts`

- [ ] **Step 1: Import recordUsage**

At the top of `client.ts`, add:

```typescript
import { recordUsage } from "./session-usage.ts";
```

- [ ] **Step 2: Call recordUsage after query completes**

In the section where the result is built (line ~437), after extracting `cost` and `duration`:

```typescript
// Record session usage
const finalSessionId = resultSessionId;
const finalCost = 'total_cost_usd' in lastMessage ? lastMessage.total_cost_usd : undefined;
const finalDuration = 'duration_ms' in lastMessage ? lastMessage.duration_ms : undefined;
if (finalSessionId && finalCost !== undefined) {
  recordUsage(finalSessionId, finalCost, finalDuration ?? 0);
}
```

Also add the same in the Haiku retry path (line ~459):

```typescript
if (retryResult.sessionId && 'total_cost_usd' in lastRetryMessage) {
  recordUsage(retryResult.sessionId, lastRetryMessage.total_cost_usd, lastRetryMessage.duration_ms ?? 0);
}
```

- [ ] **Step 3: Type check**

Run: `npx deno check claude/client.ts`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add claude/client.ts
git commit -m "feat: record session usage after each query"
```

---

### Task 6: Integrate File Preview into discord-sender.ts

**Files:**
- Modify: `claude/discord-sender.ts`

- [ ] **Step 1: Import generatePreview**

At the top of `discord-sender.ts`, add:

```typescript
import { generatePreview } from "./file-preview.ts";
```

- [ ] **Step 2: Replace tool_result file detection logic**

Find the `tool_result` file detection block (lines ~222-254). Replace the file button logic with preview-first approach:

```typescript
if (msg.type === 'tool_result' && msg.content) {
  const filePathMatches = [...new Set(msg.content.match(/(?:\.\/|\/)?(?:[\w.~-]+\/)*[\w-]+\.(?:png|jpg|jpeg|gif|webp|pdf|zip|csv|ts|js|py|go|rs|java|c|cpp|h|sh|sql|json|yaml|yml|toml|md|html|css)/gi) || [])];
  for (const p of filePathMatches) {
    let cleanPath = p.replace(/[`()"']/g, '');
    if (!cleanPath.startsWith('/')) {
      cleanPath = resolve(Deno.cwd(), cleanPath);
    }
    if (existsSync(cleanPath)) {
      const preview = await generatePreview(cleanPath);
      if (preview) {
        visibleSentSinceStatus = true;
        await sender.sendMessage(preview.content);
      } else {
        // Fallback to existing button behavior
        const fileName = cleanPath.split('/').pop() || 'attachment';
        const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        pendingFileUploads.set(fileId, { path: cleanPath, name: fileName });
        visibleSentSinceStatus = true;
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
        await sender.sendMessage({
          embeds: [{
            color: 0x2b82d4,
            title: `${isImage ? '🖼️' : '📎'} ${fileName}`,
            timestamp: true
          }],
          components: [{
            type: 'actionRow',
            components: [{
              type: 'button',
              customId: `file:${fileId}`,
              label: isImage ? '📷 查看图片' : '📥 下载文件',
              style: 'primary'
            }]
          }]
        });
      }
    }
  }
}
```

- [ ] **Step 3: Similarly update text message file detection (lines ~278-318)**

Apply the same preview-first logic in the text message handler where files are detected.

- [ ] **Step 4: Type check**

Run: `npx deno check claude/discord-sender.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add claude/discord-sender.ts
git commit -m "feat: replace file buttons with multi-type inline preview"
```

---

### Task 7: Integrate Session Usage into Completion Embed

**Files:**
- Modify: `claude/discord-sender.ts`

- [ ] **Step 1: Import getUsage**

Add to imports:

```typescript
import { getUsage } from "./session-usage.ts";
```

- [ ] **Step 2: Modify createClaudeSender to accept sessionId**

Update the function signature:

```typescript
export function createClaudeSender(sender: DiscordSender, options?: { isThread?: boolean; sessionId?: string }) {
  const isThread = options?.isThread ?? false;
  let currentSessionId = options?.sessionId;
  // ... existing code ...
```

Add a method to update sessionId (returned alongside `sendClaudeMessages`):

```typescript
  const sendClaudeMessages = async function(messages: ClaudeMessage[]) { ... };

  return {
    send: sendClaudeMessages,
    setSessionId: (id: string) => { currentSessionId = id; }
  };
```

Note: This changes the return type. All callers need to be updated from `const send = createClaudeSender(...)` to `const { send, setSessionId } = createClaudeSender(...)`.

- [ ] **Step 3: Enrich completion embed with cumulative usage**

In the `system` case handler for completion (line ~508), after the existing Cost field:

```typescript
if (msg.metadata?.total_cost_usd !== undefined) {
  const sessionUsage = currentSessionId ? getUsage(currentSessionId) : undefined;
  const costStr = sessionUsage && sessionUsage.queryCount > 1
    ? `$${msg.metadata.total_cost_usd.toFixed(4)} (session: $${sessionUsage.totalCost.toFixed(4)} / ${sessionUsage.queryCount} queries)`
    : `$${msg.metadata.total_cost_usd.toFixed(4)}`;
  embedData.fields!.push({ name: 'Cost', value: costStr, inline: true });
}
if (msg.metadata?.duration_ms !== undefined) {
  const sessionUsage = currentSessionId ? getUsage(currentSessionId) : undefined;
  const durStr = sessionUsage && sessionUsage.queryCount > 1
    ? `${(msg.metadata.duration_ms / 1000).toFixed(2)}s (session: ${(sessionUsage.totalDuration / 1000).toFixed(1)}s)`
    : `${(msg.metadata.duration_ms / 1000).toFixed(2)}s`;
  embedData.fields!.push({ name: 'Duration', value: durStr, inline: true });
}
```

- [ ] **Step 4: Type check**

Run: `npx deno check claude/discord-sender.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add claude/discord-sender.ts
git commit -m "feat: show cumulative session usage in completion embed"
```

---

### Task 8: Wire Typing Callback in Command Handlers

**Files:**
- Modify: `index.ts` (or wherever `sendToClaudeCode` is called from command handlers)

- [ ] **Step 1: Find all callsites of sendToClaudeCode**

Run: `grep -rn "sendToClaudeCode" --include="*.ts"`

- [ ] **Step 2: Pass onTyping callback at each callsite**

At each place where `sendToClaudeCode` is called, add the `onTyping` parameter. The pattern:

```typescript
const onTyping = () => {
  try { channel.sendTyping(); } catch { /* ignore */ }
};

const result = await sendToClaudeCode(
  workDir,
  prompt,
  controller,
  sessionId,
  onChunk,
  onStreamJson,
  continueMode,
  modelOptions,
  onTyping  // <-- new parameter
);
```

Where `channel` is the Discord TextChannel/ThreadChannel from the interaction.

- [ ] **Step 3: Type check full project**

Run: `npx deno check index.ts`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: wire typing indicator to Discord channel"
```

---

### Task 9: Wire Session ID to Sender + Update Callers

**Files:**
- Modify: `index.ts`, `claude/command.ts` (or wherever `createClaudeSender` is called)

- [ ] **Step 1: Find all callsites of createClaudeSender**

Run: `grep -rn "createClaudeSender" --include="*.ts"`

- [ ] **Step 2: Update callers to use new return shape**

Change from:
```typescript
const sendMessages = createClaudeSender(sender, { isThread });
```

To:
```typescript
const { send: sendMessages, setSessionId } = createClaudeSender(sender, { isThread });
```

- [ ] **Step 3: Call setSessionId when sessionId becomes available**

After `sendToClaudeCode` returns with a `sessionId`:

```typescript
if (result.sessionId) {
  setSessionId(result.sessionId);
}
```

Or if the sessionId is known before the query (resume case), pass it in options:

```typescript
const { send: sendMessages, setSessionId } = createClaudeSender(sender, { isThread, sessionId });
```

- [ ] **Step 4: Type check full project**

Run: `npx deno check index.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add index.ts claude/command.ts
git commit -m "feat: pass session ID to sender for usage display"
```

---

### Task 10: Integration Test & Bot Restart

- [ ] **Step 1: Full type check**

Run: `npx deno check index.ts`
Expected: No errors

- [ ] **Step 2: Lint**

Run: `npx deno lint`
Expected: No errors

- [ ] **Step 3: Format**

Run: `npx deno fmt`

- [ ] **Step 4: Manual smoke test**

Restart the bot and test in Discord:

1. **Typing indicator:** Send a `/query` — verify "Bot is typing..." appears in Discord while processing
2. **File preview - image:** Ask Claude to take a screenshot — verify image appears inline (not just a button)
3. **File preview - code:** Ask Claude to read a .ts file and reference it — verify code preview appears
4. **Session usage:** Send 2-3 queries in the same session — verify completion embed shows cumulative cost/duration

- [ ] **Step 5: Final commit (if any formatting changes)**

```bash
git add -A
git commit -m "chore: format and lint fixes"
```
