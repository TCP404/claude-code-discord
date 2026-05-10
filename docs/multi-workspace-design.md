# Multi-Workspace Support Design

## Context

当前 bot 是单实例单 channel 架构：一个 bot 进程绑定一个 workDir，在一个 Discord channel 里工作。用户希望单实例支持多个项目，每个项目对应一个 channel，各自有独立的 workDir、CLAUDE.md、MCP 配置和并发 session。

## 核心设计

```
单 Discord Client
  → WorkspaceManager 管理 channelId → { name, path } 映射
  → 每个 channel 独立的 Claude session + AbortController
  → 每个 channel 按各自 workDir 加载 CLAUDE.md / mcp.json
```

## Implementation Steps

### Step 1: 创建 `core/workspace-manager.ts`

新建 WorkspaceManager 类，负责 workspace CRUD 和持久化。

```ts
interface WorkspaceEntry {
  name: string; // 显示名/channel 名
  path: string; // workDir 绝对路径
  channelId: string; // 对应的 Discord channel ID
}

class WorkspaceManager {
  constructor(private defaultWorkDir: string) {}

  resolve(channelId: string): string; // 返回 workDir，fallback 到 defaultWorkDir
  add(entry: WorkspaceEntry): void;
  remove(name: string): WorkspaceEntry | undefined;
  list(): WorkspaceEntry[];
  findByChannel(channelId: string): WorkspaceEntry | undefined;
  getManagedChannelIds(): Set<string>; // 包含 default channel + 所有 workspace channels

  async loadFromDisk(): Promise<void>; // .bot-data/workspaces.json
  async saveToDisk(): Promise<void>;
}
```

### Step 2: 创建 `/workspace` slash command — `workspace/command.ts`

子命令：

- `/workspace add name:crm path:/path/to/crm` — 验证路径存在，创建 channel，保存映射
- `/workspace list` — embed 展示所有 workspace
- `/workspace remove name:crm` — 删除映射，可选删除 channel

需要传入 guild 和 category 引用来创建 channel。

### Step 3: 将 `claudeController` 改为 per-channel Map

**文件:** `index.ts`

```diff
- let claudeController: AbortController | null = null;
+ const claudeControllers = new Map<string, AbortController>();
```

修改 `getController`/`setController` 接口，改为接收 `channelId` 参数：

- `getController(channelId)` → `claudeControllers.get(channelId)`
- `setController(channelId, controller)` → `claudeControllers.set(channelId, controller)`
- abort 时只 abort 对应 channel 的 controller

**影响文件:** `index.ts`, `core/signal-handler.ts`, `core/git-shell-handlers.ts`

### Step 4: workDir 动态解析

**文件:** `core/handler-registry.ts`, `claude/command.ts`

当前 `workDir` 在 handler 创建时通过闭包捕获。改为：

- `HandlerRegistryDeps` 增加 `resolveWorkDir: (channelId: string) => string`
- `ClaudeHandlerDeps` 增加同样的 resolver
- `onClaude` handler（已有 `channelId` 参数）调用 `resolveWorkDir(channelId)` 替代静态 `workDir`
- `sendToClaudeCode` 的 `workDir` 参数改为动态获取值

同样更新 git/shell/utils handlers 中使用 workDir 的地方。

### Step 5: 每个 workspace 加载独立上下文

**文件:** `claude/client.ts`

`sendToClaudeCode` 已经接收 `workDir` 参数，内部的 `loadMcpServers(workDir)` 和 claudemd 加载已经基于 workDir。只要 Step 4 正确传入动态 workDir，上下文隔离自动生效。

验证点：确认 `sendToClaudeCode` 内的 `systemPrompt`/`claudeMdFiles` 路径拼接都基于传入的 `workDir`。

### Step 6: 更新 `isOurChannel()` — `discord/bot.ts`

- 从 `BotDependencies` 获取 `getManagedChannelIds(): Set<string>`
- `isOurChannel` 改为检查 channelId 是否在 managed set 中（包括 thread 的 parentId）
- 新 workspace channel 创建后动态更新 managed set

### Step 7: 更新 thread 消息处理

**文件:** `index.ts` 中 `messageCreate` handler

当 thread 里收到消息时，需要通过 `thread.parentId` 找到对应的 workspace channel，再 resolve workDir。

## 文件变更清单

| 文件                         | 类型 | 说明                                                          |
| ---------------------------- | ---- | ------------------------------------------------------------- |
| `core/workspace-manager.ts`  | 新建 | WorkspaceManager 类                                           |
| `workspace/command.ts`       | 新建 | /workspace 命令定义和 handler                                 |
| `workspace/index.ts`         | 新建 | barrel export                                                 |
| `index.ts`                   | 修改 | claudeControllers 改为 Map，实例化 WorkspaceManager，注册命令 |
| `core/handler-registry.ts`   | 修改 | 增加 resolveWorkDir，传递给各 handler factory                 |
| `claude/command.ts`          | 修改 | 使用 resolveWorkDir(channelId) 替代静态 workDir               |
| `discord/bot.ts`             | 修改 | isOurChannel 支持 managed channel set                         |
| `discord/types.ts`           | 修改 | BotDependencies 增加 getManagedChannelIds                     |
| `core/signal-handler.ts`     | 修改 | abort 改为按 channel                                          |
| `core/git-shell-handlers.ts` | 修改 | status/abort 命令适配 per-channel controller                  |

## 向后兼容

- 无 `/workspace add` 时，行为与当前完全一致（单 channel，默认 workDir）
- 现有 `.bot-data/session-threads.json` 不受影响
- `ALLOW_ANY_CHANNEL` env var 保留

## 验证方式

1. 启动 bot，确认默认 channel 正常工作（无 regression）
2. 执行 `/workspace add name:test path:/tmp/test-project`，确认新 channel 创建
3. 在新 channel 执行 `/claude`，确认 workDir 和上下文加载正确
4. 两个 channel 同时运行 Claude session，确认互不干扰
5. `/workspace list` 展示所有映射
6. `/workspace remove` 清理
