# UX Enhancements Design: Typing Indicator, File Preview, Session Usage

## 1. Typing Indicator

### Mechanism

Call `channel.sendTyping()` at a fixed interval while Claude SDK is processing a query. Discord's typing state lasts 10 seconds; we use an 8-second interval to prevent gaps.

### Trigger Lifecycle

- **Start:** Immediately on entering the SDK message iteration loop in `sendToClaudeCode()`. Fire one `sendTyping()` call right away, then start interval.
- **End:** Clear interval when the query completes, is aborted, or errors out.

### Interface Change

Add an optional callback to `sendToClaudeCode()`:

```typescript
onTyping?: () => void
```

The caller (command handler) passes in `() => channel.sendTyping()`. The client manages the interval internally:

```typescript
// Inside sendToClaudeCode, before SDK iteration
let typingInterval: ReturnType<typeof setInterval> | undefined;
if (onTyping) {
  onTyping(); // immediate first call
  typingInterval = setInterval(onTyping, 8000);
}

// In finally block
clearInterval(typingInterval);
```

### Edge Cases

- Query completes in < 8s: only the initial `sendTyping()` fires, which is fine.
- Abort: `finally` block ensures interval is always cleared.
- `sendTyping()` failure (e.g., missing permissions): swallow error silently — typing is non-critical.

---

## 2. File Preview Enhancement

### Strategy

Replace the current "detect file path → show button" flow with type-aware inline preview. Each file type has a preview strategy with a graceful fallback to the existing button behavior.

### Preview Rules

| File Type | Extensions                                                         | Preview                                                       | Size Limit | Fallback                 |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------- | ---------- | ------------------------ |
| Image     | png, jpg, jpeg, gif, webp                                          | Inline attachment (Discord auto-embeds)                       | 10 MB      | Button                   |
| PDF       | pdf                                                                | First-page PNG via `sips` + page count text                   | N/A        | Button + page count text |
| Code      | ts, js, py, go, rs, java, c, cpp, h, sh, sql, json, yaml, toml, md | First 20 lines in fenced code block + "View full file" button | 100 KB     | Button only              |
| CSV       | csv                                                                | First 5 rows as Markdown table + row count                    | 50 KB      | Row count + button       |
| Other     | zip, tar, gz, etc.                                                 | No preview (existing button behavior)                         | —          | —                        |

### Implementation

New function in `claude/discord-sender.ts`:

```typescript
async function previewFile(
  filePath: string,
  sender: DiscordSender,
): Promise<void>;
```

Dispatches based on extension. Returns without error on failure (silent fallback to button).

#### Image Preview

```typescript
const stats = await Deno.stat(filePath);
if (stats.size > 10 * 1024 * 1024) {
  // fallback: send button
  return;
}
// Send as attachment — Discord auto-embeds images
await sender.sendMessage({ files: [{ path: filePath, name: basename(filePath) }] });
```

#### PDF Preview

```typescript
const tmpPng = `/tmp/pdf-preview-${Date.now()}.png`;
const cmd = new Deno.Command("sips", {
  args: ["-s", "format", "png", filePath, "--out", tmpPng],
});
const result = await cmd.output();
if (result.success) {
  // send tmpPng as attachment + text with page count
} else {
  // fallback: button + "PDF (N pages)" text
}
```

Note: `sips` on macOS can convert PDF first page to PNG. On Linux, fallback to `pdftoppm` if available, otherwise text-only.

#### Code Preview

```typescript
const content = await Deno.readTextFile(filePath);
const lines = content.split("\n").slice(0, 20);
const ext = extname(filePath).slice(1);
const codeBlock = `\`\`\`${ext}\n${lines.join("\n")}\n\`\`\``;
// Send code block + "View full file" button if file has more than 20 lines
```

#### CSV Preview

```typescript
const content = await Deno.readTextFile(filePath);
const lines = content.split("\n");
const totalRows = lines.length - 1; // minus header
const previewLines = lines.slice(0, 6); // header + 5 rows
// Format as Markdown table
const table = formatAsMarkdownTable(previewLines);
// Send table + "N rows total" + button if large
```

### Integration Point

In `discord-sender.ts`, replace the current file button logic (lines ~222-318) with:

```typescript
// After detecting file paths
for (const file of detectedFiles) {
  await previewFile(file.path, sender);
}
```

Images no longer go through `pendingFileUploads` map since they're sent inline. Other types still use the button as a "view full" mechanism.

---

## 3. Session-Level Usage Tracking

### Data Structure

```typescript
interface SessionUsage {
  totalCost: number; // cumulative USD
  totalDuration: number; // cumulative ms
  queryCount: number; // number of queries in session
}

const sessionUsageMap = new Map<string, SessionUsage>();
```

### Storage Location

New module: `claude/session-usage.ts` exporting:

```typescript
export function recordUsage(sessionId: string, cost: number, duration: number): SessionUsage;
export function getUsage(sessionId: string): SessionUsage | undefined;
export function clearUsage(sessionId: string): void;
export function clearAll(): void;
```

### Recording

At the end of `sendToClaudeCode()`, after extracting `cost` and `duration` from the SDK result:

```typescript
if (sessionId && cost !== undefined) {
  recordUsage(sessionId, cost, duration ?? 0);
}
```

### Display

In `discord-sender.ts`, the `system:completion` embed handler (lines ~488-544), extend the existing Cost and Duration fields:

```
Cost: $0.0234 (session: $0.1580 / 5 queries)
Duration: 12.3s (session: 89.2s)
```

Format:

```typescript
const usage = getUsage(sessionId);
const costValue = usage
  ? `$${cost.toFixed(4)} (session: $${usage.totalCost.toFixed(4)} / ${usage.queryCount} queries)`
  : `$${cost.toFixed(4)}`;
```

### Lifecycle

- **Create:** On first `recordUsage()` call for a sessionId.
- **Clear:** When `/new` command creates a new session (calls `clearUsage(oldSessionId)`).
- **Reset all:** On bot restart (Map is in-memory only, no persistence needed).

### Passing sessionId to Sender

The completion message handler in `discord-sender.ts` needs access to `sessionId` to look up cumulative usage. Options:

- Pass `sessionId` in the `options` parameter of `createClaudeSender()`:
  ```typescript
  createClaudeSender(sender, { isThread, sessionId });
  ```
- Update `sessionId` dynamically (since it may be assigned after first query), expose a setter on the returned sender function.

Recommended: pass via options, update when sessionId changes.

---

## Summary of Files to Modify

| File                                              | Changes                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `claude/client.ts`                                | Add `onTyping` callback, call `recordUsage()` at query end                                     |
| `claude/discord-sender.ts`                        | Add `previewFile()`, modify file detection flow, extend completion embed with cumulative usage |
| `claude/session-usage.ts`                         | **New file** — session usage tracking module                                                   |
| Command handlers (index.ts / handler-registry.ts) | Pass `onTyping` callback, pass `sessionId` to sender                                           |

## Dependencies

- No new npm packages required.
- PDF preview uses system commands (`sips` on macOS, `pdftoppm` on Linux) — both optional with graceful fallback.
