/** @module process — Barrel export for process management and crash handling. */
export { 
  ProcessCrashHandler, 
  setupGlobalErrorHandlers, 
  ProcessHealthMonitor,
  withCrashReporting
} from "./crash-handler.ts";
export type { 
  CrashReport, 
  RecoveryOptions 
} from "./crash-handler.ts";