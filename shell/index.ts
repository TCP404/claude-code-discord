/** @module shell — Barrel export for shell execution module. */
export * from "./types.ts";
export { ShellManager } from "./handler.ts";
export { createShellHandlers, shellCommands, type ShellHandlerDeps } from "./command.ts";
