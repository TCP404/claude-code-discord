/** @module git — Barrel export for git operations module. */
export * from "./types.ts";
export * from "./handler.ts";
export { gitCommands, createGitHandlers, type GitHandlerDeps } from "./command.ts";
export { WorktreeBotManager } from "./process-manager.ts";