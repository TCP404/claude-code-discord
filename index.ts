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
  createDiscordBot,
  type BotConfig,
  type CommandHandlers,
  type ButtonHandlers,
  type BotDependencies,
  SessionThreadManager,
  createDiscordSenderAdapter,
  createChannelSenderAdapter,
  createAskUserDiscordHandler,
  createPermissionRequestHandler,
  createSessionThreadCallbacks,
  cleanupPaginationStates,
} from "./discord/index.ts";
import type { TextChannel } from "npm:discord.js@14.14.1";

import { getGitInfo } from "./git/index.ts";
import { createClaudeSender, expandableContent } from "./claude/discord-sender.ts";
import { sendToClaudeCode } from "./claude/client.ts";
import { convertToClaudeMessages } from "./claude/message-converter.ts";
import type { ClaudeMessage } from "./claude/types.ts";
import type { SessionThreadCallbacks } from "./claude/command.ts";
import { BOT_SYSTEM_PROMPT } from "./claude/bot-system-prompt.ts";
import type { AskUserQuestionInput } from "./claude/user-question.ts";
import type { PermissionRequestCallback } from "./claude/permission-request.ts";
import { initModels } from "./claude/enhanced-client.ts";
import { DEFAULT_SETTINGS, UNIFIED_DEFAULT_SETTINGS } from "./settings/index.ts";
import { runVersionCheck, startPeriodicUpdateCheck, BOT_VERSION } from "./util/version-check.ts";

// Core modules
import {
  parseArgs,
  createMessageHistory,
  createBotManagers,
  setupPeriodicCleanup,
  createBotSettings,
  createAllHandlers,
  createClaudeSession,
  getAllCommands,
  cleanSessionId,
  createButtonHandlers,
  createAllCommandHandlers,
  WorkspaceManager,
  loadEnvFile,
  type BotManagers,
  type AllHandlers,
  type MessageHistoryOps,
} from "./core/index.ts";
import { createWorkspaceHandlers } from "./workspace/index.ts";

// Re-export for backward compatibility
export { getGitInfo, executeGitCommand } from "./git/index.ts";
export { sendToClaudeCode } from "./claude/client.ts";

// ================================
// Bot Creation
// ================================

/**
 * Create Claude Code Discord Bot with all handlers and integrations.
 */
export async function createClaudeCodeBot(config: BotConfig) {
  const { discordToken, applicationId, workDir, repoName, branchName, categoryName, defaultMentionUserId } = config;
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
        console.warn(`Process crash: ${report.processType} ${report.processId || ''} - ${report.error.message}`);
      },
    },
  });

  const { shellManager, worktreeBotManager, crashHandler, healthMonitor, claudeSessionManager } = managers;

  initModels();

  const cleanupInterval = setupPeriodicCleanup(managers, 3600000, [
    cleanupPaginationStates,
  ]);

  const settingsOps = createBotSettings(defaultMentionUserId, DEFAULT_SETTINGS, UNIFIED_DEFAULT_SETTINGS);
  const currentSettings = settingsOps.getSettings();
  const botSettings = currentSettings.legacy;

  // deno-lint-ignore no-explicit-any prefer-const
  let bot: any;
  let claudeSender: { send: (messages: ClaudeMessage[]) => Promise<void>; setSessionId: (id: string) => void } | null = null;

  const sessionThreadManager = new SessionThreadManager();
  await sessionThreadManager.loadFromDisk();

  const workspaceManager = new WorkspaceManager(workDir);
  await workspaceManager.loadFromDisk();

  // Per-channel routing maps
  // deno-lint-ignore no-explicit-any
  const responseChannels = new Map<string, any>();
  // deno-lint-ignore no-explicit-any
  const commandChannels = new Map<string, any>();

  // Session thread callbacks (thread creation/resume)
  const sessionThreadCallbacks: SessionThreadCallbacks = createSessionThreadCallbacks({
    sessionThreadManager,
    getBot: () => bot,
    commandChannels,
  });

  // Late-bound interactive handlers
  const askUserState: { handler: ((input: AskUserQuestionInput) => Promise<Record<string, string>>) | null } = { handler: null };
  const permReqState: { handler: PermissionRequestCallback | null } = { handler: null };

  const sendClaudeMessages = async (messages: ClaudeMessage[]) => {
    if (claudeSender) {
      await claudeSender.send(messages);
    }
  };

  const onAskUser = async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    if (!askUserState.handler) {
      throw new Error('AskUserQuestion handler not initialized — bot not ready');
    }
    return await askUserState.handler(input);
  };

  const onPermissionRequest: PermissionRequestCallback = async (toolName, toolInput) => {
    if (!permReqState.handler) {
      console.warn('[PermissionRequest] Handler not initialized — auto-denying');
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
      claudeSessionManager,
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
    settingsOps
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
  handlers.set('workspace', {
    execute: async (ctx) => {
      await workspaceHandlers.onWorkspace(ctx);
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
    expandableContent
  );

  // Channel monitoring for auto-responding to bot/webhook messages
  const monitorChannelId = Deno.env.get("MONITOR_CHANNEL_ID");
  const monitorBotIds = Deno.env.get("MONITOR_BOT_IDS")?.split(",").map(s => s.trim()).filter(Boolean);

  // Create dependencies object for Discord bot
  const dependencies: BotDependencies = {
    commands: getAllCommands(),
    cleanSessionId,
    botSettings,
    getManagedChannelIds: () => workspaceManager.getManagedChannelIds(),
    onContinueSession: async (ctx) => {
      await allHandlers.claude.onContinue(ctx);
    },
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

          const { send: threadSender, setSessionId } = createClaudeSender(createChannelSenderAdapter(thread), { isThread: true });

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
            false,
            undefined,
            () => {
              try {
                thread.sendTyping();
              } catch { /* ignore */ }
            }
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

      if (sessionId.startsWith('pending_') || sessionId.startsWith('failed_')) {
        console.warn(`[ThreadMessage] Session not ready (${sessionId.slice(0, 20)}…), ignoring message`);
        return;
      }

      const thread = sessionThreadManager.getThread(sessionId);
      if (!thread) {
        console.warn(`[ThreadMessage] Thread channel not resolved for session ${sessionId}, cannot resume`);
        return;
      }

      const thinkingMsg = await thread.send('`Claude is thinking...`');

      const { send: threadSender, setSessionId } = createClaudeSender(createChannelSenderAdapter(thread), { isThread: true, sessionId });
      const controller = new AbortController();
      const threadKey = threadChannelId;
      claudeSessionOps.setController(controller, threadKey);

      const parentChannelId = (thread as any).parentId ?? threadChannelId;
      const effectiveWorkDir = workspaceManager.resolve(parentChannelId);

      try {
        const result = await sendToClaudeCode(
          effectiveWorkDir,
          content,
          controller,
          sessionId,
          undefined,
          (jsonData) => {
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              threadSender(claudeMessages).catch(() => {});
            }
          },
          false,
          { appendSystemPrompt: BOT_SYSTEM_PROMPT },
          () => {
            try {
              thread.sendTyping();
            } catch { /* ignore */ }
          }
        );

        if (result.sessionId) {
          claudeSessionOps.setSessionId(result.sessionId, threadKey);
          setSessionId(result.sessionId);
        }
      } catch (error) {
        console.error(`[ThreadMessage] Failed to resume session ${sessionId}:`, error);
        const errMsg = error instanceof Error ? error.message : String(error);
        await thread.send(`⚠️ Failed to resume session: ${errMsg}`).catch(() => {});
      } finally {
        claudeSessionOps.setController(null, threadKey);
        try { await thinkingMsg.delete(); } catch { /* ignore */ }
      }
    },
    setResponseChannel: (ch: any) => {
      const chId = ch?.id;
      if (chId) {
        responseChannels.set(chId, ch);
        commandChannels.set(chId, ch);
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
    const orphans = workspaceManager.list().filter(w => !guild.channels.cache.has(w.channelId));
    if (orphans.length > 0) {
      for (const o of orphans) {
        console.log(`[Workspace] Removing orphan workspace "${o.name}" (channel ${o.channelId} no longer exists)`);
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
      if (meta.sessionId.startsWith('pending_')) {
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
        embed.fields.forEach(f => discordEmbed.addFields(f));
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
          .setDescription(`A newer version is available. You are running **v${BOT_VERSION}** (\`${result.localCommit}\`).`)
          .addFields(
            { name: "Latest Commit", value: `\`${result.remoteCommit}\``, inline: true },
            {
              name: "How to Update",
              value: Deno.env.get("DOCKER_CONTAINER")
                ? "```\ndocker compose pull && docker compose up -d\n```"
                : "```\ngit pull origin main && deno task start\n```",
              inline: false
            }
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
    bot: bot as any,
  });

  return bot;
}

// ================================
// Signal Handlers
// ================================

function setupSignalHandlers(ctx: {
  managers: BotManagers;
  allHandlers: AllHandlers;
  getClaudeController: () => AbortController | null;
  abortAllSessions?: () => void;
  claudeSender: { send: (messages: ClaudeMessage[]) => Promise<void>; setSessionId: (id: string) => void } | null;
  actualCategoryName: string;
  repoName: string;
  branchName: string;
  cleanupInterval: number;
  // deno-lint-ignore no-explicit-any
  bot: any;
}) {
  const { managers, allHandlers, getClaudeController, abortAllSessions, claudeSender, actualCategoryName, repoName, branchName, cleanupInterval, bot } = ctx;
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

      if (claudeSender) {
        await claudeSender.send([{
          type: 'system',
          content: '',
          metadata: {
            subtype: 'shutdown',
            signal,
            categoryName: actualCategoryName,
            repoName,
            branchName
          }
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
      console.error('Error during shutdown:', error);
      Deno.exit(1);
    }
  };

  try {
    Deno.addSignalListener("SIGINT", () => handleSignal("SIGINT"));
    try {
      Deno.addSignalListener("SIGTERM", () => handleSignal("SIGTERM"));
    } catch (unixError) {
      const message = unixError instanceof Error ? unixError.message : String(unixError);
      console.warn('Could not register SIGTERM handler:', message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Signal handler registration error:', message);
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
