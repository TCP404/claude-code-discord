/** @module discord — Barrel export for Discord layer components. */
// Discord utilities and components
export { createDiscordBot } from "./bot.ts";
export { sanitizeChannelName, splitText } from "./utils.ts";
export {
  cleanupPaginationStates,
  createPaginatedEmbeds,
  createPaginatedMessage,
  createPaginationButtons,
  handlePaginationInteraction,
  initializePagination,
  smartSplit,
} from "./pagination.ts";
export {
  createFormattedEmbed,
  formatError,
  formatFileContent,
  formatGitOutput,
  formatShellOutput,
  formatText,
  needsFormatting,
} from "./formatting.ts";
export type {
  BotConfig,
  BotDependencies,
  ButtonHandlers,
  CommandHandlers,
  ComponentData,
  EmbedData,
  InteractionContext,
  MessageContent,
  MonitorConfig,
  SessionThread,
} from "./types.ts";
export { SessionThreadManager, threadNameFromPrompt } from "./session-threads.ts";

// Message sending utilities
export {
  createChannelSenderAdapter,
  createDiscordSenderAdapter,
  sendMessageContent,
  sendMessageContentTracked,
} from "./message-sender.ts";

// Interactive handlers
export { createAskUserDiscordHandler } from "./ask-user-handler.ts";
export { createPermissionRequestHandler } from "./permission-handler.ts";

// Session thread callbacks
export {
  createSessionThreadCallbacks,
  type SessionThreadCallbackDeps,
} from "./session-thread-callbacks.ts";

// Re-export shared types for convenience
export type { BotSettings, BotSettingsUpdater } from "../types/shared.ts";
export type { PaginatedContent, PaginationOptions, PaginationState } from "./pagination.ts";
export type { FormatOptions } from "./formatting.ts";
