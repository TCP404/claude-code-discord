/** @module core — Barrel export for bot infrastructure (config, signal, factory, handlers). */
//
// Prefer importing from source files directly for better traceability.
// This barrel exists for the top-level index.ts assembly.
//

export { parseArgs, loadEnvConfig, validateEnvConfig, loadConfig, loadConfigOrExit, ConfigurationError } from "./config-loader.ts";
export type { AppConfig, ParsedArgs, EnvConfig, ConfigLoaderDeps } from "./config-loader.ts";

export { createShutdownHandler, setupSignalHandlers, removeSignalHandlers } from "./signal-handler.ts";
export type { CleanupContext, ShutdownSignal, SignalHandlerConfig, SignalHandlerResult } from "./signal-handler.ts";

export { createShellManager, createWorktreeBotManager, createClaudeSessionManager, createCrashHandler, createBotManagers, setupPeriodicCleanup, createBotContext, validateBotFactoryDeps, createBotContextOrThrow, shutdownBotContext, DEFAULT_CRASH_HANDLER_OPTIONS, DEFAULT_CLEANUP_INTERVAL_MS } from "./bot-factory.ts";
export type { BotManagers, BotContext, CrashHandlerOptions, CrashReport, BotFactoryDeps, ValidationResult } from "./bot-factory.ts";

export { createMessageHistory, createClaudeSession, createBotSettings, createAllHandlers, getAllCommands, cleanSessionId } from "./handler-registry.ts";
export type { MessageHistoryState, MessageHistoryOps, ClaudeSessionState, ClaudeSessionOps, BotSettingsState, BotSettingsOps, AllHandlers, HandlerRegistryDeps, HandlerRegistry } from "./handler-registry.ts";

export { createButtonHandlers, createExpandButtonHandler } from "./button-handlers.ts";
export type { ButtonHandlerDeps, ExpandableContentMap } from "./button-handlers.ts";

export { createSystemCommandHandlers, createParameterizedSystemHandlers, createClaudeCommandHandlers, createSettingsCommandHandlers, createAllCommandHandlers } from "./command-wrappers.ts";
export type { CommandWrapperDeps } from "./command-wrappers.ts";

export { createGitCommandHandlers, createShellCommandHandlers, createUtilityCommandHandlers } from "./git-shell-handlers.ts";
export type { GitShellHandlerDeps } from "./git-shell-handlers.ts";

export { WorkspaceManager } from "./workspace-manager.ts";
export type { WorkspaceEntry } from "./workspace-manager.ts";

export { loadEnvFile } from "./env-loader.ts";
