#!/usr/bin/env -S deno run --allow-all

/**
 * Claude Code Discord Bot - Main Entry Point
 *
 * This file bootstraps the Discord bot with Claude Code integration.
 * Most logic is extracted to dedicated modules — this file handles
 * assembly and startup only.
 *
 * @module index
 */

import {
  type BotConfig,
  type BotDependencies,
  type ButtonHandlers,
  cleanupPaginationStates,
  type CommandHandlers,
  createAskUserDiscordHandler,
  createChannelSenderAdapter,
  createDiscordBot,
  createDiscordSenderAdapter,
  createPermissionRequestHandler,
  createSessionThreadCallbacks,
  SessionThreadManager,
} from "./discord/index.ts";
import type { TextChannel } from "npm:discord.js@14.14.1";

import { getGitInfo } from "./git/index.ts";
import { createClaudeSender, expandableContent } from "./claude/discord-sender.ts";
import { sendToClaudeCode } from "./claude/client.ts";
import { readHotQueryConfig } from "./claude/hot-query-config.ts";
import { HotQueryRegistry } from "./claude/hot-query-registry.ts";
import { HotQuerySession, makeSdkQueryFactory } from "./claude/hot-query.ts";
import { convertToClaudeMessages } from "./claude/message-converter.ts";
import type { ClaudeMessage } from "./claude/types.ts";
import type { SessionThreadCallbacks } from "./claude/command.ts";
import { BOT_SYSTEM_PROMPT } from "./claude/bot-system-prompt.ts";
import type { AskUserQuestionInput } from "./claude/user-question.ts";
import type { PermissionRequestCallback } from "./claude/permission-request.ts";
import { initModels } from "./claude/models.ts";
import { DEFAULT_SETTINGS, UNIFIED_DEFAULT_SETTINGS } from "./settings/index.ts";
import { BOT_VERSION, runVersionCheck, startPeriodicUpdateCheck } from "./util/version-check.ts";

// Core modules
import {
  type AllHandlers,
  type BotManagers,
  cleanSessionId,
  createAllCommandHandlers,
  createAllHandlers,
  createBotManagers,
  createBotSettings,
  createButtonHandlers,
  createClaudeSession,
  createMessageHistory,
  getAllCommands,
  loadEnvFile,
  type MessageHistoryOps,
  parseArgs,
  setupPeriodicCleanup,
  WorkspaceManager,
} from "./core/index.ts";
import { createWorkspaceHandlers } from "./workspace/index.ts";

// Re-export for backward compatibility
export { executeGitCommand, getGitInfo } from "./git/index.ts";
export { sendToClaudeCode } from "./claude/client.ts";

// ================================
// Bot Creation
// ================================

/**
 * Create Claude Code Discord Bot with all handlers and integrations.
 */
export async function createClaudeCodeBot(config: BotConfig) {
  const {
    discordToken,
    applicationId,
    workDir,
    repoName,
    branchName,
    categoryName,
    defaultMentionUserId,
  } = config;
  const actualCategoryName = categoryName || repoName;

  // Session & workspace management
  const claudeSessionOps = createClaudeSession();
  const messageHistoryOps: MessageHistoryOps = createMessageHistory(50);

  const managers: BotManagers = createBotManagers({
    config: {
      discordToken,
      applicationId,
      workDir,
      categoryName: actualCategoryName,
      userId: defaultMentionUserId,
    },
    crashHandlerOptions: {
      maxRetries: 3,
      retryDelay: 5000,
      enableAutoRestart: true,
      logCrashes: true,
      notifyOnCrash: true,
      // deno-lint-ignore require-await
      onCrashNotification: async (report) => {
        console.warn(
          `Process crash: ${report.processType} ${
            report.processId || ""
          } - ${report.error.message}`,
        );
      },
    },
  });

  const { shellManager, worktreeBotManager, crashHandler, healthMonitor } = managers;

  initModels();

  const cleanupInterval = setupPeriodicCleanup(managers, 3600000, [
    cleanupPaginationStates,
  ]);

  const settingsOps = createBotSettings(
    defaultMentionUserId,
    DEFAULT_SETTINGS,
    UNIFIED_DEFAULT_SETTINGS,
  );
  const currentSettings = settingsOps.getSettings();
  const botSettings = currentSettings.legacy;

  // deno-lint-ignore prefer-const
  let bot: any;
  let claudeSender: {
    send: (messages: ClaudeMessage[]) => Promise<void>;
    setSessionId: (id: string) => void;
  } | null = null;

  const sessionThreadManager = new SessionThreadManager();
  await sessionThreadManager.loadFromDisk();

  const workspaceManager = new WorkspaceManager(workDir);
  await workspaceManager.loadFromDisk();

  const hotQueryConfig = readHotQueryConfig((k) => Deno.env.get(k));
  const hotQueryRegistry = new HotQueryRegistry({
    maxSessions: hotQueryConfig.maxSessions,
    idleMs: hotQueryConfig.idleMs,
    onEvict: (sessionId, reason) => {
      console.log(`[HotQuery] session=${sessionId} closed (reason: ${reason})`);
      if (reason === "shutdown") return;
      const thread = sessionThreadManager.getThread(sessionId);
      if (!thread) return;
      const messages: Record<string, string> = {
        lru: "🧊 Hot session evicted (max sessions reached), next message will cold-start.",
        idle: "🧊 Hot session expired (idle timeout), next message will cold-start.",
        manual: "🧊 Hot session closed.",
      };
      const msg = messages[reason] ?? `🧊 Hot session closed (${reason}).`;
      thread.send(msg).catch(() => {});
    },
  });

  // Per-channel routing maps
  const responseChannels = new Map<string, any>();
  const commandChannels = new Map<string, any>();

  // Session thread callbacks (thread creation/resume)
  const sessionThreadCallbacks: SessionThreadCallbacks = createSessionThreadCallbacks({
    sessionThreadManager,
    getBot: () => bot,
    commandChannels,
  });

  // Late-bound interactive handlers
  const askUserState: {
    handler: ((input: AskUserQuestionInput) => Promise<Record<string, string>>) | null;
  } = { handler: null };
  const permReqState: { handler: PermissionRequestCallback | null } = { handler: null };

  const sendClaudeMessages = async (messages: ClaudeMessage[]) => {
    if (claudeSender) {
      await claudeSender.send(messages);
    }
  };

  const onAskUser = async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    if (!askUserState.handler) {
      throw new Error("AskUserQuestion handler not initialized — bot not ready");
    }
    return await askUserState.handler(input);
  };

  const onPermissionRequest: PermissionRequestCallback = async (toolName, toolInput) => {
    if (!permReqState.handler) {
      console.warn("[PermissionRequest] Handler not initialized — auto-denying");
      return false;
    }
    return await permReqState.handler(toolName, toolInput);
  };

  // Create all handlers using the registry
  const allHandlers: AllHandlers = createAllHandlers(
    {
      workDir,
      resolveWorkDir: (channelId: string) => workspaceManager.resolve(channelId),
      repoName,
      branchName,
      categoryName: actualCategoryName,
      discordToken,
      applicationId,
      defaultMentionUserId,
      shellManager,
      worktreeBotManager,
      crashHandler,
      healthMonitor,
      sendClaudeMessages,
      onAskUser,
      onPermissionRequest,
      onBotSettingsUpdate: (settings) => {
        botSettings.mentionEnabled = settings.mentionEnabled;
        botSettings.mentionUserId = settings.mentionUserId;
        if (bot) {
          bot.updateBotSettings(settings);
        }
      },
      sessionThreads: sessionThreadCallbacks,
    },
    claudeSessionOps,
    settingsOps,
  );

  // Command handlers
  const handlers: CommandHandlers = createAllCommandHandlers({
    handlers: allHandlers,
    messageHistory: messageHistoryOps,
    getClaudeController: () => claudeSessionOps.getController(),
    getClaudeSessionId: () => claudeSessionOps.getSessionId(),
    crashHandler,
    healthMonitor,
    botSettings,
    cleanupInterval,
  });

  // Workspace handlers
  const workspaceHandlers = createWorkspaceHandlers({
    workspaceManager,
    sessionThreadManager,
    getGuild: () => bot?.getGuild?.() ?? null,
    getCategory: () => bot?.getCategory?.() ?? null,
  });
  handlers.set("workspace", {
    execute: async (ctx) => {
      await workspaceHandlers.onWorkspace(ctx);
    },
  });

  // Hot queries handler
  handlers.set("hot-queries", {
    execute: async (ctx) => {
      const rows = hotQueryRegistry.list();
      const { createdTotal, reusedTotal } = hotQueryRegistry.stats();
      if (rows.length === 0) {
        await ctx.reply({
          content:
            `📭 No active hot queries. (lifetime: ${createdTotal} created, ${reusedTotal} reused)`,
          ephemeral: true,
        });
        return;
      }
      const lines = rows.map((r) => {
        const threadName = sessionThreadManager.getSessionThread(r.sessionId)?.threadName ??
          "(unknown thread)";
        return `• \`${r.sessionId.slice(0, 8)}…\` "${threadName}" idle=${
          Math.floor(r.idleMs / 1000)
        }s reuse=${r.reuseCount} model=${r.model ?? "default"}`;
      });
      const header = `🔥 Active hot queries (lifetime: ${createdTotal} created, ${reusedTotal} reused):`;
      await ctx.reply({
        content: [header, ...lines].join("\n"),
        ephemeral: true,
      });
    },
  });

  // Per-thread hot query toggle
  handlers.set("hot-query", {
    execute: async (ctx) => {
      const sub = ctx.getSubcommand();
      const channelId = ctx.getChannelId();
      const sessionId = sessionThreadManager.findSessionByThreadId(channelId);

      if (!sessionId) {
        await ctx.reply({
          content: "⚠️ This command must be used inside a session thread.",
          ephemeral: true,
        });
        return;
      }

      if (sub === "enable") {
        sessionThreadManager.setHotQuery(sessionId, true);
        await ctx.reply({
          content: "🔥 Hot query enabled for this thread. Next message will use hot mode.",
          ephemeral: true,
        });
      } else if (sub === "disable") {
        sessionThreadManager.setHotQuery(sessionId, false);
        const existing = hotQueryRegistry.get(sessionId);
        if (existing && !existing.busy) {
          await hotQueryRegistry.close(sessionId, "manual");
        }
        await ctx.reply({
          content: "🧊 Hot query disabled for this thread. Next message will use cold mode.",
          ephemeral: true,
        });
      } else {
        const current = sessionThreadManager.getHotQuery(sessionId) ?? hotQueryConfig.enabled;
        const active = hotQueryRegistry.get(sessionId);
        const status = current ? "🔥 enabled" : "🧊 disabled";
        const activeStr = active ? " (active session)" : "";
        await ctx.reply({
          content: `Hot query: ${status}${activeStr} (global default: ${hotQueryConfig.enabled ? "on" : "off"})`,
          ephemeral: true,
        });
      }
    },
  });

  // Button handlers
  const buttonHandlers: ButtonHandlers = createButtonHandlers(
    {
      messageHistory: messageHistoryOps,
      handlers: allHandlers,
      getClaudeSessionId: () => claudeSessionOps.getSessionId(),
      sendClaudeMessages,
      workDir,
    },
    expandableContent,
  );

  // Channel monitoring for auto-responding to bot/webhook messages
  const monitorChannelId = Deno.env.get("MONITOR_CHANNEL_ID");
  const monitorBotIds = Deno.env.get("MONITOR_BOT_IDS")?.split(",").map((s) => s.trim()).filter(
    Boolean,
  );

  // Create dependencies object for Discord bot
  const dependencies: BotDependencies = {
    commands: getAllCommands(),
    cleanSessionId,
    botSettings,
    getManagedChannelIds: () => workspaceManager.getManagedChannelIds(),
    ...(monitorChannelId && monitorBotIds?.length && {
      monitorConfig: {
        channelId: monitorChannelId,
        botIds: monitorBotIds,
        onAlertMessage: async (content: string, thread: TextChannel) => {
          const prompt = [
            "A monitoring alert notification was just received. Investigate this alert.",
            "Identify the alert, check severity, gather diagnostics, analyze the root cause, and report findings.",
            "If a config change is needed, describe what should change. If it's a transient issue, report findings.",
            "",
            "Alert content:",
            content,
          ].join("\n");

          const { send: threadSender, setSessionId } = createClaudeSender(
            createChannelSenderAdapter(thread),
            { isThread: true },
          );

          const controller = new AbortController();
          const result = await sendToClaudeCode(
            workDir,
            prompt,
            controller,
            undefined,
            undefined,
            (jsonData) => {
              const claudeMessages = convertToClaudeMessages(jsonData);
              if (claudeMessages.length > 0) {
                threadSender(claudeMessages).catch(() => {});
              }
            },
            undefined,
            () => {
              try {
                thread.sendTyping();
              } catch { /* ignore */ }
            },
          );
          if (result.sessionId) {
            setSessionId(result.sessionId);
          }
        },
      },
    }),
    onThreadMessage: async (threadChannelId: string, content: string) => {
      const sessionId = sessionThreadManager.findSessionByThreadId(threadChannelId);
      if (!sessionId) {
        console.warn(`[ThreadMessage] No session found for thread ${threadChannelId}, ignoring`);
        return;
      }
      if (sessionId.startsWith("pending_") || sessionId.startsWith("failed_")) {
        console.warn(
          `[ThreadMessage] Session not ready (${sessionId.slice(0, 20)}…), ignoring message`,
        );
        return;
      }
      const thread = sessionThreadManager.getThread(sessionId);
      if (!thread) {
        console.warn(
          `[ThreadMessage] Thread channel not resolved for session ${sessionId}, cannot resume`,
        );
        return;
      }

      const thinkingMsg = await thread.send("`Claude is thinking...`");
      sessionThreadManager.recordActivity(sessionId);

      const { send: threadSender, setSessionId } = createClaudeSender(
        createChannelSenderAdapter(thread),
        { isThread: true, sessionId },
      );
      const controller = new AbortController();
      const threadKey = threadChannelId;
      claudeSessionOps.setController(controller, threadKey);

      const parentChannelId = (thread as any).parentId ?? threadChannelId;
      const effectiveWorkDir = workspaceManager.resolve(parentChannelId);
      const turnOptions = { appendSystemPrompt: BOT_SYSTEM_PROMPT };

      let hotReuseCount = -1 as number; // -1 = cold mode
      const onStreamJson = (jsonData: any) => {
        if (hotReuseCount >= 0 && jsonData.type === "result") {
          jsonData._hotReuse = hotReuseCount;
        }
        const claudeMessages = convertToClaudeMessages(jsonData);
        if (claudeMessages.length > 0) {
          threadSender(claudeMessages).catch(() => {});
        }
      };
      const onTyping = () => {
        try {
          thread.sendTyping();
        } catch { /* ignore */ }
      };

      try {
        const useHot = sessionThreadManager.getHotQuery(sessionId) ?? hotQueryConfig.enabled;
        if (useHot) {
          let hot = hotQueryRegistry.get(sessionId);
          if (!hot) {
            console.log(`[HotQuery] session=${sessionId} creating (cold init)`);
            const t0 = Date.now();
            const factory = await makeSdkQueryFactory(
              effectiveWorkDir,
              turnOptions,
              sessionId,
              controller,
            );
            hot = HotQuerySession.create({
              sessionId,
              workDir: effectiveWorkDir,
              options: turnOptions,
              queryFactory: factory,
            });
            await hotQueryRegistry.register(hot);
            console.log(`[HotQuery] session=${sessionId} created in ${Date.now() - t0}ms`);
            hotReuseCount = 0;
          } else {
            console.log(`[HotQuery] session=${sessionId} reused (skip cold-init)`);
            hotQueryRegistry.touch(sessionId);
            hotReuseCount = hotQueryRegistry.getReuseCount(sessionId);
          }
          const result = await hot.runTurn(content, controller, {
            onStreamJson,
            onTyping,
          });
          if (result.sessionId) {
            claudeSessionOps.setSessionId(result.sessionId, threadKey);
            setSessionId(result.sessionId);
          }
        } else {
          const result = await sendToClaudeCode(
            effectiveWorkDir,
            content,
            controller,
            sessionId,
            undefined,
            onStreamJson,
            turnOptions,
            onTyping,
          );
          if (result.sessionId) {
            claudeSessionOps.setSessionId(result.sessionId, threadKey);
            setSessionId(result.sessionId);
          }
        }
      } catch (error) {
        console.error(`[ThreadMessage] Failed to resume session ${sessionId}:`, error);
        const errMsg = error instanceof Error ? error.message : String(error);
        await thread.send(`⚠️ Failed to resume session: ${errMsg}`).catch(() => {});
      } finally {
        claudeSessionOps.setController(null, threadKey);
        try {
          await thinkingMsg.delete();
        } catch { /* ignore */ }
      }
    },
    setResponseChannel: (ch: any) => {
      const chId = ch?.id;
      if (chId) {
        responseChannels.set(chId, ch);
        commandChannels.set(chId, ch);
      }
    },
    isAutoThreadChannel: (channelId: string) => workspaceManager.isAutoThreadChannel(channelId),
    onWorkspaceMessage: async (channelId: string, content: string) => {
      const channel = commandChannels.get(channelId) ??
        bot?.getGuild?.()?.channels.cache.get(channelId);
      if (!channel) {
        console.warn(`[WorkspaceMessage] Channel ${channelId} not found, ignoring`);
        return;
      }

      // Register the channel for routing
      commandChannels.set(channelId, channel);
      responseChannels.set(channelId, channel);

      // Create a thread with a `new-` prefixed name (so renameThreadByTopic can detect it later)
      const { threadNameFromPrompt } = await import("./discord/session-threads.ts");
      const body = threadNameFromPrompt(content.trim());
      const budget = DISCORD_THREAD_NAME_MAX - PENDING_RENAME_PREFIX.length;
      const trimmedName = body.length <= budget ? body : body.slice(0, budget - 1) + "…";
      const autoThreadName = PENDING_RENAME_PREFIX + trimmedName;

      let threadResult;
      try {
        threadResult = await sessionThreadCallbacks.createThreadSender(
          content,
          undefined,
          autoThreadName,
          channelId,
        );
      } catch (err) {
        console.error("[WorkspaceMessage] Failed to create thread:", err);
        return;
      }

      const { sender, threadSessionKey, threadChannelId } = threadResult;
      const thread = sessionThreadManager.getThread(threadSessionKey);

      const controller = new AbortController();
      claudeSessionOps.setController(controller, threadChannelId);

      let thinkingMsg: any = null;
      if (thread) {
        try {
          thinkingMsg = await thread.send("`Claude is thinking...`");
        } catch { /* ignore */ }
      }

      const effectiveWorkDir = workspaceManager.resolve(channelId);

      try {
        const result = await sendToClaudeCode(
          effectiveWorkDir,
          content,
          controller,
          undefined,
          undefined,
          (jsonData) => {
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              sender.send(claudeMessages).catch(() => {});
            }
          },
          { appendSystemPrompt: BOT_SYSTEM_PROMPT },
          () => {
            try {
              thread?.sendTyping();
            } catch { /* ignore */ }
          },
        );

        if (result.sessionId) {
          sessionThreadManager.updateSessionId(threadSessionKey, result.sessionId);
          claudeSessionOps.setSessionId(result.sessionId, threadChannelId);
          claudeSessionOps.setSessionId(result.sessionId, channelId);
          sender.setSessionId(result.sessionId);
        }

        // Best-effort: rename thread with a Haiku-generated topic
        if (thread && result.sessionId) {
          renameThreadByTopic(thread, effectiveWorkDir, result.sessionId).catch((err) => {
            console.warn("[WorkspaceMessage] Thread rename failed:", err);
          });
        }
      } catch (error) {
        console.error("[WorkspaceMessage] Claude run failed:", error);
        if (threadSessionKey.startsWith("pending_")) {
          sessionThreadManager.updateSessionId(threadSessionKey, `failed_${threadSessionKey}`);
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        try {
          await thread?.send(`⚠️ Claude failed: ${errMsg}`);
        } catch { /* ignore */ }
      } finally {
        claudeSessionOps.setController(null, threadChannelId);
        if (thinkingMsg) {
          try {
            await thinkingMsg.delete();
          } catch { /* ignore */ }
        }
      }
    },
  };

  // Create Discord bot
  bot = await createDiscordBot(config, handlers, buttonHandlers, dependencies, crashHandler);

  // Restore persisted sessions
  const mainChannel = bot.getChannel() as TextChannel | null;
  if (mainChannel) {
    await sessionThreadManager.restoreThreadChannels(mainChannel);
    workspaceManager.setDefaultChannelId(mainChannel.id);

    const guild = mainChannel.guild;
    const orphans = workspaceManager.list().filter((w) => !guild.channels.cache.has(w.channelId));
    if (orphans.length > 0) {
      for (const o of orphans) {
        console.log(
          `[Workspace] Removing orphan workspace "${o.name}" (channel ${o.channelId} no longer exists)`,
        );
        workspaceManager.remove(o.name);
      }
      await workspaceManager.saveToDisk();
    }
  }

  // Start admin web UI
  const { startAdminServer } = await import("./admin/index.ts");
  startAdminServer({
    workspaceManager,
    sessionThreadManager,
    discordClient: bot.client,
    botStartTime: Date.now(),
  });

  // Create Discord sender for Claude messages
  claudeSender = createClaudeSender(createDiscordSenderAdapter(bot, responseChannels));

  // Resolve target channel for interactive handlers
  const getActiveSessionChannel = () => {
    const currentSessionId = claudeSessionOps.getSessionId();
    if (currentSessionId) {
      const thread = sessionThreadManager.getThread(currentSessionId);
      if (thread) return thread;
    }
    const allThreads = sessionThreadManager.getAllSessionThreads();
    for (const meta of allThreads) {
      if (meta.sessionId.startsWith("pending_")) {
        const thread = sessionThreadManager.getThread(meta.sessionId);
        if (thread) return thread;
      }
    }
    return bot.getChannel();
  };

  // Initialize interactive handlers
  askUserState.handler = createAskUserDiscordHandler(bot, getActiveSessionChannel);
  permReqState.handler = createPermissionRequestHandler(bot, getActiveSessionChannel);

  // Version check (non-blocking)
  runVersionCheck().then(async ({ updateAvailable, embed }) => {
    if (updateAvailable && embed) {
      const channel = bot.getChannel();
      if (channel) {
        const { EmbedBuilder } = await import("npm:discord.js@14.14.1");
        const discordEmbed = new EmbedBuilder()
          .setColor(embed.color)
          .setTitle(embed.title)
          .setDescription(embed.description)
          .setTimestamp();
        embed.fields.forEach((f) => discordEmbed.addFields(f));
        await channel.send({ embeds: [discordEmbed] });
      }
    }
  }).catch(() => {});

  startPeriodicUpdateCheck(async (result) => {
    try {
      const channel = bot.getChannel();
      if (channel) {
        const { EmbedBuilder } = await import("npm:discord.js@14.14.1");
        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle("🔄 Update Available")
          .setDescription(
            `A newer version is available. You are running **v${BOT_VERSION}** (\`${result.localCommit}\`).`,
          )
          .addFields(
            { name: "Latest Commit", value: `\`${result.remoteCommit}\``, inline: true },
            {
              name: "How to Update",
              value: Deno.env.get("DOCKER_CONTAINER")
                ? "```\ndocker compose pull && docker compose up -d\n```"
                : "```\ngit pull origin main && deno task start\n```",
              inline: false,
            },
          )
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    } catch {
      // Periodic notification is best-effort
    }
  });

  // Signal handlers for graceful shutdown
  setupSignalHandlers({
    managers,
    allHandlers,
    getClaudeController: () => claudeSessionOps.getController(),
    abortAllSessions: () => claudeSessionOps.abortAll(),
    claudeSender,
    actualCategoryName,
    repoName,
    branchName,
    cleanupInterval,
    closeHotQueries: () => hotQueryRegistry.closeAll("shutdown"),
    bot: bot as any,
  });

  return bot;
}

// ================================
// Auto-Thread Helpers
// ================================

const PENDING_RENAME_PREFIX = "new-";
const DISCORD_THREAD_NAME_MAX = 100;

async function renameThreadByTopic(thread: any, workDir: string, sessionId: string): Promise<void> {
  try {
    const currentName: string = thread?.name ?? "";
    if (!currentName.startsWith(PENDING_RENAME_PREFIX)) return;

    const { getSessionMessages, query: claudeQuery } = await import(
      "@anthropic-ai/claude-agent-sdk"
    );

    const msgs = await getSessionMessages(sessionId, { dir: workDir });

    let context = "";
    for (const msg of msgs) {
      const m = msg as any;
      if (!m.message?.content) continue;
      if (m.type !== "user" && m.type !== "assistant") continue;
      const texts = (m.message.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "");
      const combined = texts.join(" ").trim();
      if (!combined || combined.length < 20) continue;
      const role = m.type === "user" ? "User" : "Assistant";
      context += `${role}: ${combined.slice(0, 300)}\n`;
      if (context.length > 1500) break;
    }

    if (context.length < 50) return;

    let title = "";
    const result = claudeQuery({
      prompt:
        `Summarize the topic of the following conversation as a short phrase (5-10 words). Output only the title itself.\n\n${context}`,
      options: {
        maxTurns: 1,
        cwd: "/tmp",
        model: "haiku",
        systemPrompt:
          "You are a title generator. Output a single short topic title (5-10 words). No explanations, no quotes, no trailing punctuation.",
      },
    });
    for await (const ev of result) {
      const e = ev as any;
      if (e.type === "assistant" && e.message?.content) {
        for (const block of e.message.content) {
          if (block.type === "text") title += block.text;
        }
      }
    }

    title = title
      .split(/\r?\n/)[0]
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/[#*`_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length > DISCORD_THREAD_NAME_MAX) {
      title = title.slice(0, DISCORD_THREAD_NAME_MAX - 1) + "…";
    }

    if (!title || title.length < 5) return;

    await thread.setName(title);
    console.log(
      `[renameThreadByTopic] Renamed thread to "${title}" for session ${sessionId.slice(0, 8)}`,
    );
  } catch (err) {
    console.warn("[renameThreadByTopic]", err instanceof Error ? err.message : String(err));
  }
}

// ================================
// Signal Handlers
// ================================

function setupSignalHandlers(ctx: {
  managers: BotManagers;
  allHandlers: AllHandlers;
  getClaudeController: () => AbortController | null;
  abortAllSessions?: () => void;
  claudeSender: {
    send: (messages: ClaudeMessage[]) => Promise<void>;
    setSessionId: (id: string) => void;
  } | null;
  actualCategoryName: string;
  repoName: string;
  branchName: string;
  cleanupInterval: number;
  closeHotQueries?: () => Promise<void>;
  bot: any;
}) {
  const {
    managers,
    allHandlers,
    getClaudeController,
    abortAllSessions,
    claudeSender,
    actualCategoryName,
    repoName,
    branchName,
    cleanupInterval,
    closeHotQueries,
    bot,
  } = ctx;
  const { crashHandler, healthMonitor } = managers;
  const { shell: shellHandlers, git: gitHandlers } = allHandlers;

  const handleSignal = async (signal: string) => {
    console.log(`\n${signal} signal received. Stopping bot...`);

    try {
      shellHandlers.killAllProcesses();
      gitHandlers.killAllWorktreeBots();

      if (abortAllSessions) {
        abortAllSessions();
      } else {
        const claudeController = getClaudeController();
        if (claudeController) {
          claudeController.abort();
        }
      }

      // Close all hot queries (streaming-input sessions)
      if (closeHotQueries) {
        try {
          await closeHotQueries();
        } catch (err) {
          console.error("Error closing hot queries:", err);
        }
      }

      if (claudeSender) {
        await claudeSender.send([{
          type: "system",
          content: "",
          metadata: {
            subtype: "shutdown",
            signal,
            categoryName: actualCategoryName,
            repoName,
            branchName,
          },
        }]);
      }

      healthMonitor.stopAll();
      crashHandler.cleanup();
      cleanupPaginationStates();
      clearInterval(cleanupInterval);

      setTimeout(() => {
        bot.client.destroy();
        Deno.exit(0);
      }, 1000);
    } catch (error) {
      console.error("Error during shutdown:", error);
      Deno.exit(1);
    }
  };

  try {
    Deno.addSignalListener("SIGINT", () => handleSignal("SIGINT"));
    try {
      Deno.addSignalListener("SIGTERM", () => handleSignal("SIGTERM"));
    } catch (unixError) {
      const message = unixError instanceof Error ? unixError.message : String(unixError);
      console.warn("Could not register SIGTERM handler:", message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Signal handler registration error:", message);
  }
}

// ================================
// Main Execution
// ================================

if (import.meta.main) {
  try {
    await loadEnvFile();

    const discordToken = Deno.env.get("DISCORD_TOKEN");
    const applicationId = Deno.env.get("APPLICATION_ID");
    const envCategoryName = Deno.env.get("CATEGORY_NAME");
    const envMentionUserId = Deno.env.get("USER_ID") || Deno.env.get("DEFAULT_MENTION_USER_ID");
    const envWorkDir = Deno.env.get("WORK_DIR");

    if (!discordToken || !applicationId) {
      console.error("╔═══════════════════════════════════════════════════════════╗");
      console.error("║  Error: Missing required configuration                    ║");
      console.error("╠═══════════════════════════════════════════════════════════╣");
      console.error("║  DISCORD_TOKEN and APPLICATION_ID are required.           ║");
      console.error("║                                                           ║");
      console.error("║  Options:                                                 ║");
      console.error("║  1. Create a .env file with these variables               ║");
      console.error("║  2. Set environment variables before running              ║");
      console.error("║  3. Run /discord-bot-setup in Claude Code                  ║");
      console.error("╚═══════════════════════════════════════════════════════════╝");
      Deno.exit(1);
    }

    const args = parseArgs(Deno.args);
    const categoryName = args.category || envCategoryName;
    const defaultMentionUserId = args.userId || envMentionUserId;
    const workDir = envWorkDir || Deno.cwd();

    const gitInfo = await getGitInfo();

    await createClaudeCodeBot({
      discordToken,
      applicationId,
      workDir,
      repoName: gitInfo.repo,
      branchName: gitInfo.branch,
      categoryName,
      defaultMentionUserId,
    });

    console.log("✓ Bot has started. Press Ctrl+C to stop.");
  } catch (error) {
    console.error("Failed to start bot:", error);
    Deno.exit(1);
  }
}
