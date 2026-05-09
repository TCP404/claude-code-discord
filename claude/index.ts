/** @module claude — Barrel export for Claude Code SDK integration. */
//
// Prefer importing from source files directly (e.g. ./claude/client.ts).
// This barrel exists for backward-compatibility and top-level re-exports only.
//

// Types
export type { ClaudeMessage, ClaudeResponse, TodoItem } from "./types.ts";
export type { ClaudeModelOptions, SDKPermissionMode, ThinkingConfig, EffortLevel, SDKAgentDefinition, SDKModelInfo } from "./client.ts";
export type { DiscordSender, TrackedMessage } from "./discord-sender.ts";
export type { SessionThreadCallbacks } from "./command.ts";
export type { AskUserCallback, AskUserQuestionInput } from "./user-question.ts";
export type { PermissionRequestCallback } from "./permission-request.ts";
export type { EnhancedClaudeOptions, ClaudeSession, ModelInfo } from "./enhanced-client.ts";
export type { HookConfig, HookEvent_Discord } from "./hooks.ts";
export type { ClaudeInitInfo } from "./query-manager.ts";

// Runtime values used by top-level assembly (index.ts)
export { sendToClaudeCode, cleanSessionId } from "./client.ts";
export { createClaudeSender, expandableContent, hiddenMessageTypes, pendingFileUploads } from "./discord-sender.ts";
export { convertToClaudeMessages } from "./message-converter.ts";
export { ClaudeSessionManager, initModels } from "./enhanced-client.ts";
