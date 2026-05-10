/** @module claude/command — /ask slash command: simple single-turn Claude query. */
import type { ClaudeMessage, ClaudeResponse } from "./types.ts";
import { type ClaudeModelOptions, sendToClaudeCode } from "./client.ts";
import { convertToClaudeMessages } from "./message-converter.ts";
import { SlashCommandBuilder } from "npm:discord.js@14.14.1";

// Callback that creates (or retrieves) a session thread and returns a
// sender function bound to that thread.
export interface SessionThreadCallbacks {
  /**
   * Create a new Discord thread for this session and return a sender bound to it.
   * Also posts a summary embed in the main channel linking to the thread.
   *
   * @param prompt The user's prompt (used to name the thread)
   * @param sessionId Optional pre-existing session ID (reuses thread if one exists)
   * @returns Object with the thread-bound sender and a placeholder session key
   */
  createThreadSender(
    prompt: string,
    sessionId?: string,
    threadName?: string,
    channelId?: string,
  ): Promise<{
    sender: {
      send: (messages: ClaudeMessage[]) => Promise<void>;
      setSessionId: (id: string) => void;
    };
    threadSessionKey: string;
    threadChannelId: string;
  }>;
  /**
   * Look up an existing thread for a session (does NOT create one).
   * Returns undefined if the session has no thread.
   */
  getThreadSender(sessionId: string): Promise<
    {
      sender: {
        send: (messages: ClaudeMessage[]) => Promise<void>;
        setSessionId: (id: string) => void;
      };
      threadSessionKey: string;
    } | undefined
  >;
  /**
   * Update the session key mapping when the real SDK session ID arrives.
   */
  updateSessionId(oldKey: string, newSessionId: string): void;
}

// Discord command definitions
export const claudeCommands = [
  new SlashCommandBuilder()
    .setName("claude")
    .setDescription("Send message to Claude Code (auto-continues in current channel)")
    .addStringOption((option) =>
      option.setName("prompt")
        .setDescription("Prompt for Claude Code")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("session_id")
        .setDescription("Session ID to resume (optional)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("claude-thread")
    .setDescription("Start a new Claude session in a dedicated thread")
    .addStringOption((option) =>
      option.setName("name")
        .setDescription("Thread name")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("prompt")
        .setDescription("Prompt for Claude Code")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("claude-cancel")
    .setDescription("Cancel currently running Claude Code command"),
];

export interface ClaudeHandlerDeps {
  workDir: string;
  /** Resolve workDir dynamically by channelId (falls back to workDir if unset) */
  resolveWorkDir?: (channelId: string) => string;
  getClaudeController: (channelId?: string) => AbortController | null;
  setClaudeController: (controller: AbortController | null, channelId?: string) => void;
  /** Get session ID for a specific channel/thread (per-channel tracking) */
  getSessionForChannel: (channelId: string) => string | undefined;
  /** Set session ID for a specific channel/thread */
  setSessionForChannel: (channelId: string, sessionId: string | undefined) => void;
  /** Get session ID (optionally scoped to channel) */
  getClaudeSessionId: (channelId?: string) => string | undefined;
  /** Set session ID (optionally scoped to channel) */
  setClaudeSessionId: (sessionId: string | undefined, channelId?: string) => void;
  /** Default sender — used when no thread is available (fallback) */
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  /** Get current runtime options from unified settings (thinking, operation, proxy) */
  getQueryOptions?: () => ClaudeModelOptions;
  /** Thread-per-session callbacks (optional — when absent, falls back to main channel) */
  sessionThreads?: SessionThreadCallbacks;
}

export function createClaudeHandlers(deps: ClaudeHandlerDeps) {
  const { workDir, resolveWorkDir, sendClaudeMessages } = deps;

  return {
    /**
     * /claude — Send a message to Claude. Auto-continues the session active in the
     * current channel/thread. Starts a new session only if there isn't one yet.
     */
    // deno-lint-ignore no-explicit-any
    async onClaude(
      ctx: any,
      prompt: string,
      channelId: string,
      explicitSessionId?: string,
    ): Promise<ClaudeResponse> {
      const existingController = deps.getClaudeController(channelId);
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller, channelId);

      await ctx.deferReply();

      // Resolve which session to resume:
      // 1) Explicit session_id from user → resume that
      // 2) Active session in this channel/thread → resume that
      // 3) None → start a new session
      const activeSessionId = explicitSessionId || deps.getSessionForChannel(channelId);

      // Pick the right sender — if this channel has a thread, use it
      let activeSender = sendClaudeMessages;
      let senderSetSessionId: ((id: string) => void) | null = null;
      if (activeSessionId && deps.sessionThreads) {
        try {
          const existing = await deps.sessionThreads.getThreadSender(activeSessionId);
          if (existing) {
            activeSender = existing.sender.send;
            senderSetSessionId = existing.sender.setSessionId;
          }
        } catch { /* fallback to main sender */ }
      }

      const isResuming = !!activeSessionId;

      await ctx.editReply({
        embeds: [{
          color: 0xffff00,
          title: isResuming ? "Claude Code Continuing..." : "Claude Code Running...",
          description: isResuming ? "Continuing session..." : "Starting new session...",
          fields: [{ name: "Prompt", value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          timestamp: true,
        }],
      });

      const effectiveWorkDir = resolveWorkDir?.(channelId) ?? workDir;

      const result = await sendToClaudeCode(
        effectiveWorkDir,
        prompt,
        controller,
        activeSessionId, // resume if present, new session if undefined
        undefined,
        (jsonData) => {
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            activeSender(claudeMessages).catch(() => {});
          }
        },
        deps.getQueryOptions?.(),
        () => {
          try {
            ctx.channel?.sendTyping();
          } catch { /* ignore */ }
        },
      );

      // Track session per-channel and globally
      if (result.sessionId) {
        deps.setSessionForChannel(channelId, result.sessionId);
        if (senderSetSessionId) {
          senderSetSessionId(result.sessionId);
        }
      }
      deps.setClaudeSessionId(result.sessionId, channelId);
      deps.setClaudeController(null, channelId);

      return result;
    },

    /**
     * /claude-thread — Start a brand-new session in a dedicated Discord thread.
     */
    // deno-lint-ignore no-explicit-any
    async onClaudeThread(
      ctx: any,
      prompt: string,
      channelId: string,
      threadName?: string,
    ): Promise<ClaudeResponse> {
      const existingController = deps.getClaudeController(channelId);
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller, channelId);

      await ctx.deferReply();

      // Create a dedicated thread for this session
      let activeSender = sendClaudeMessages;
      let senderSetSessionId: ((id: string) => void) | null = null;
      let threadSessionKey: string | undefined;
      let threadChannelId: string | undefined;

      if (deps.sessionThreads) {
        try {
          const threadResult = await deps.sessionThreads.createThreadSender(
            prompt,
            undefined,
            threadName,
            channelId,
          );
          activeSender = threadResult.sender.send;
          senderSetSessionId = threadResult.sender.setSessionId;
          threadSessionKey = threadResult.threadSessionKey;
          threadChannelId = threadResult.threadChannelId;
        } catch (err) {
          console.warn(
            "[SessionThread] Could not create thread, falling back to main channel:",
            err,
          );
        }
      }

      await ctx.editReply({
        embeds: [{
          color: 0xffff00,
          title: "Claude Code Running...",
          description: threadSessionKey
            ? "Session started in a dedicated thread — check below ↓"
            : "Starting new session...",
          fields: [{ name: "Prompt", value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          timestamp: true,
        }],
      });

      const effectiveWorkDir = resolveWorkDir?.(channelId) ?? workDir;

      let result;
      try {
        result = await sendToClaudeCode(
          effectiveWorkDir,
          prompt,
          controller,
          undefined, // always a new session
          undefined,
          (jsonData) => {
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              activeSender(claudeMessages).catch(() => {});
            }
          },
          deps.getQueryOptions?.(),
          () => {
            try {
              ctx.channel?.sendTyping();
            } catch { /* ignore */ }
          },
        );
      } catch (err) {
        // Clean up the pending placeholder so thread messages don't try to resume it
        if (threadSessionKey && deps.sessionThreads) {
          deps.sessionThreads.updateSessionId(threadSessionKey, `failed_${threadSessionKey}`);
        }
        throw err;
      }

      deps.setClaudeSessionId(result.sessionId, channelId);
      deps.setClaudeController(null, channelId);

      // Map the thread channel → session so /claude inside the thread auto-continues
      if (threadSessionKey && result.sessionId && deps.sessionThreads) {
        deps.sessionThreads.updateSessionId(threadSessionKey, result.sessionId);
      }
      if (threadChannelId && result.sessionId) {
        deps.setSessionForChannel(threadChannelId, result.sessionId);
        if (senderSetSessionId) {
          senderSetSessionId(result.sessionId);
        }
      }

      return result;
    },

    // deno-lint-ignore no-explicit-any
    onClaudeCancel(_ctx: any, channelId?: string): boolean {
      const currentController = deps.getClaudeController(channelId);
      if (!currentController) {
        return false;
      }

      console.log("Cancelling Claude Code session...");
      currentController.abort();
      deps.setClaudeController(null, channelId);
      deps.setClaudeSessionId(undefined, channelId);

      return true;
    },
  };
}
