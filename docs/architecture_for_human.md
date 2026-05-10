# Architecture Overview

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Discord Server                               │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ /claude  │  │  /git    │  │ /shell   │  │ Thread messages  │   │
│  │ /agent   │  │  /system │  │ /settings│  │ (auto-resume)    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
└───────┼──────────────┼─────────────┼─────────────────┼──────────────┘
        │              │             │                  │
        └──────────────┴─────────────┴──────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Discord Bot (Deno)                            │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    discord/ layer                            │    │
│  │  bot.ts → event routing, slash command dispatch             │    │
│  │  session-threads.ts → one thread per Claude session         │    │
│  │  message-sender.ts → embed/button/file delivery             │    │
│  └──────────────────────────────┬──────────────────────────────┘    │
│                                 │                                    │
│  ┌──────────────────────────────▼──────────────────────────────┐    │
│  │                    core/ layer                               │    │
│  │  handler-registry.ts → routes commands to handlers          │    │
│  │  workspace-manager.ts → multi-channel workspace routing     │    │
│  │  config-loader.ts → env/CLI → AppConfig                     │    │
│  └──────────────────────────────┬──────────────────────────────┘    │
│                                 │                                    │
│  ┌──────────────────────────────▼──────────────────────────────┐    │
│  │                    claude/ layer                             │    │
│  │  enhanced-client.ts → session management, model registry    │    │
│  │  client.ts → SDK query builder, streaming                   │    │
│  │  discord-sender.ts → status line + renderer orchestration   │    │
│  └──────────────────────────────┬──────────────────────────────┘    │
│                                 │                                    │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│              @anthropic-ai/claude-agent-sdk                          │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │  Streaming │  │    MCP     │  │  Agents   │  │  Permissions │  │
│  │  Messages  │  │  Servers   │  │ Definitions│  │   & Hooks   │  │
│  └────────────┘  └────────────┘  └───────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │  AWS Bedrock / Anthropic  │
                    │       API Backend         │
                    └──────────────────────────┘
```

## Message Lifecycle

一条用户消息从发出到收到回复的完整流程：

```
┌─────────┐        ┌─────────────┐       ┌─────────────┐       ┌──────────┐
│  User   │        │  Discord    │       │   Bot Core  │       │  Claude  │
│         │        │  Gateway    │       │             │       │   SDK    │
└────┬────┘        └──────┬──────┘       └──────┬──────┘       └────┬─────┘
     │                     │                     │                    │
     │  /claude "fix bug"  │                     │                    │
     │────────────────────▶│                     │                    │
     │                     │  interaction event  │                    │
     │                     │────────────────────▶│                    │
     │                     │                     │                    │
     │                     │                     │─── create thread ──┐
     │                     │                     │                    │
     │                     │                     │─── build options ──┐
     │                     │                     │    (model, prompt, │
     │                     │                     │     MCP, settings) │
     │                     │                     │                    │
     │                     │                     │  sendToClaudeCode  │
     │                     │                     │───────────────────▶│
     │                     │                     │                    │
     │                     │                     │  stream messages   │
     │                     │                     │◀═══════════════════│
     │                     │                     │  (text, tool_use,  │
     │                     │                     │   thinking, etc)   │
     │                     │                     │                    │
     │                     │  ┌────────────────┐ │                    │
     │                     │  │ discord-sender │ │                    │
     │                     │  │                │ │                    │
     │                     │  │ hidden msgs →  │ │                    │
     │                     │  │   status line  │ │                    │
     │                     │  │                │ │                    │
     │                     │  │ visible msgs → │ │                    │
     │  embed/text/file    │  │   embeds/text  │ │                    │
     │◀════════════════════│◀─│                │ │                    │
     │                     │  └────────────────┘ │                    │
     │                     │                     │                    │
     │                     │                     │  completion event  │
     │  ✅ cost + duration │                     │◀───────────────────│
     │◀════════════════════│◀────────────────────│                    │
     │                     │                     │                    │
```

## Multi-Workspace 模型

```
          ┌──────────────────────────────┐
          │     Single Bot Instance       │
          │                               │
          │   WorkspaceManager            │
          │   ┌────────────────────────┐  │
          │   │ channelId → workDir    │  │
          │   │                        │  │
          │   │ #proj-A → /code/proj-A │  │
          │   │ #proj-B → /code/proj-B │  │
          │   │ #proj-C → /code/proj-C │  │
          │   └────────────────────────┘  │
          │                               │
          └───────┬───────┬───────┬───────┘
                  │       │       │
         ┌────────┘       │       └────────┐
         ▼                ▼                 ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Channel A   │ │  Channel B   │ │  Channel C   │
│              │ │              │ │              │
│ ┌──Thread 1  │ │ ┌──Thread 1  │ │ ┌──Thread 1  │
│ ├──Thread 2  │ │ └──Thread 2  │ │ └──Thread 2  │
│ └──Thread 3  │ │              │ │              │
│              │ │              │ │              │
│  cwd: proj-A │ │  cwd: proj-B │ │  cwd: proj-C │
└──────────────┘ └──────────────┘ └──────────────┘
```

## 交互式流程

### AskUserQuestion（Claude 向用户提问）

```
Claude SDK                Bot                      Discord
    │                      │                         │
    │  askUser callback    │                         │
    │─────────────────────▶│                         │
    │                      │  embed + buttons        │
    │                      │────────────────────────▶│
    │                      │                         │  ← user clicks
    │                      │  button interaction     │
    │                      │◀────────────────────────│
    │  return answers      │                         │
    │◀─────────────────────│                         │
    │                      │                         │
    │  (continues query)   │                         │
```

### Permission Request（工具权限审批）

```
Claude SDK                Bot                      Discord
    │                      │                         │
    │  canUseTool(name)    │                         │
    │─────────────────────▶│                         │
    │                      │                         │
    │                      │─ mcp__* ? auto-allow    │
    │                      │                         │
    │                      │─ else: send embed ─────▶│
    │                      │  [Allow] [Deny]         │
    │                      │                         │  ← user clicks
    │                      │◀────────────────────────│
    │  allow/deny          │                         │
    │◀─────────────────────│                         │
```

## Key Design Decisions

| Decision                          | Why                                          |
| --------------------------------- | -------------------------------------------- |
| Thread-per-session                | 保持对话隔离，支持并发会话                   |
| Status line (single editable msg) | 避免刷屏，工具调用信息折叠在一条消息中       |
| Workspace-per-channel             | 一个 bot 实例服务多个项目，通过 channel 路由 |
| Direct imports (no deep barrels)  | 每个 import 直接指向源文件，方便追踪         |
| Types in dedicated files          | 类型与实现分离，减少循环依赖                 |
| MCP auto-allow                    | `mcp__*` 工具自动批准，减少交互摩擦          |
| Deno runtime                      | 原生 TypeScript，无编译步骤，权限沙箱        |
