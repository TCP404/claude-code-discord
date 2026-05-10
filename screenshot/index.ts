/**
 * Screenshot module exports
 */

export { captureScreenshot, cleanupScreenshot, getScreenshotEnvironment } from "./handler.ts";
export { screenshotCommands } from "./command.ts";
export { createScreenshotHandlers } from "./handlers.ts";
export type { ScreenshotEnvironment, ScreenshotResult } from "./types.ts";
