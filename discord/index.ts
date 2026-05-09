// Discord utilities and components
export { createDiscordBot } from "./bot.ts";
export { sanitizeChannelName, splitText } from "./utils.ts";
export {
  createPaginatedEmbeds,
  createPaginationButtons,
  initializePagination,
  handlePaginationInteraction,
  cleanupPaginationStates,
  smartSplit,
  createPaginatedMessage
} from "./pagination.ts";
export {
  formatText,
  formatFileContent,
  formatShellOutput,
  formatGitOutput,
  formatError,
  needsFormatting,
  createFormattedEmbed
} from "./formatting.ts";
export type {
  BotConfig,
  CommandHandlers,
  ButtonHandlers,
  MessageContent,
  InteractionContext,
  BotDependencies,
  MonitorConfig,
  SessionThread,
  EmbedData,
  ComponentData
} from "./types.ts";
export { SessionThreadManager, threadNameFromPrompt } from "./session-threads.ts";

// Message sending utilities
export {
  sendMessageContent,
  sendMessageContentTracked,
  createDiscordSenderAdapter,
  createChannelSenderAdapter,
} from "./message-sender.ts";

// Interactive handlers
export { createAskUserDiscordHandler } from "./ask-user-handler.ts";
export { createPermissionRequestHandler } from "./permission-handler.ts";

// Session thread callbacks
export { createSessionThreadCallbacks, type SessionThreadCallbackDeps } from "./session-thread-callbacks.ts";

// Re-export shared types for convenience
export type { BotSettings, BotSettingsUpdater } from "../types/shared.ts";
export type {
  PaginationOptions,
  PaginatedContent,
  PaginationState
} from "./pagination.ts";
export type {
  FormatOptions
} from "./formatting.ts";
