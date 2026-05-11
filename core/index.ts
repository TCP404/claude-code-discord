/** @module core — Barrel export for bot infrastructure (config, signal, factory, handlers). */
//
// Prefer importing from source files directly for better traceability.
// This barrel exists for the top-level index.ts assembly.
//

export {
  ConfigurationError,
  loadConfig,
  loadConfigOrExit,
  loadEnvConfig,
  parseArgs,
  validateEnvConfig,
} from "./config-loader.ts";
export type { AppConfig, ConfigLoaderDeps, EnvConfig, ParsedArgs } from "./config-loader.ts";

export {
  createShutdownHandler,
  removeSignalHandlers,
  setupSignalHandlers,
} from "./signal-handler.ts";
export type {
  CleanupContext,
  ShutdownSignal,
  SignalHandlerConfig,
  SignalHandlerResult,
} from "./signal-handler.ts";

export {
  createBotContext,
  createBotContextOrThrow,
  createBotManagers,
  createCrashHandler,
  createShellManager,
  createWorktreeBotManager,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CRASH_HANDLER_OPTIONS,
  setupPeriodicCleanup,
  shutdownBotContext,
  validateBotFactoryDeps,
} from "./bot-factory.ts";
export type {
  BotContext,
  BotFactoryDeps,
  BotManagers,
  CrashHandlerOptions,
  CrashReport,
  ValidationResult,
} from "./bot-factory.ts";

export {
  cleanSessionId,
  createAllHandlers,
  createBotSettings,
  createClaudeSession,
  createMessageHistory,
  getAllCommands,
} from "./handler-registry.ts";
export type {
  AllHandlers,
  BotSettingsOps,
  BotSettingsState,
  ClaudeSessionOps,
  ClaudeSessionState,
  HandlerRegistry,
  HandlerRegistryDeps,
  MessageHistoryOps,
  MessageHistoryState,
} from "./handler-registry.ts";

export { createButtonHandlers, createExpandButtonHandler } from "./button-handlers.ts";
export type { ButtonHandlerDeps, ExpandableContentMap } from "./button-handlers.ts";

export {
  createAllCommandHandlers,
  createClaudeCommandHandlers,
  createParameterizedSystemHandlers,
  createSettingsCommandHandlers,
  createSystemCommandHandlers,
} from "./command-wrappers.ts";
export type { CommandWrapperDeps } from "./command-wrappers.ts";

export {
  createGitCommandHandlers,
  createShellCommandHandlers,
  createUtilityCommandHandlers,
} from "./git-shell-handlers.ts";
export type { GitShellHandlerDeps } from "./git-shell-handlers.ts";

export { WorkspaceManager } from "./workspace-manager.ts";
export type { WorkspaceEntry } from "./workspace-manager.ts";

export { loadEnvFile } from "./env-loader.ts";
