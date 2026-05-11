/** @module settings — Barrel export for settings commands and types. */
// Advanced settings exports (legacy)
export { advancedSettingsCommands, DEFAULT_SETTINGS } from "./advanced-settings.ts";
export { createAdvancedSettingsHandlers } from "./handlers.ts";
export type { AdvancedBotSettings } from "./advanced-settings.ts";
export type { SettingsHandlerDeps } from "./handlers.ts";

// New unified settings exports
export {
  ANTHROPIC_RATE_LIMITS,
  EFFORT_LEVELS,
  mcpCommand,
  OPERATION_MODES,
  THINKING_MODES,
  todosCommand,
  UNIFIED_DEFAULT_SETTINGS,
  unifiedSettingsCommands,
} from "./unified-settings.ts";
export { createUnifiedSettingsHandlers } from "./unified-handlers.ts";
export type { RateLimitTier, UnifiedBotSettings } from "./unified-settings.ts";
export type {
  MCPJsonConfig,
  MCPJsonServerEntry,
  TodoItem,
  UnifiedSettingsHandlerDeps,
} from "./unified-handlers.ts";
