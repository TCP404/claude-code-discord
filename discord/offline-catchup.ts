/**
 * Offline Message Catch-up — fetches user messages sent while bot was offline,
 * posts an inbox-style prompt with Process / Ignore buttons in the original
 * channel, and routes the user's choice to the existing thread / workspace
 * message handlers.
 *
 * @module discord/offline-catchup
 */

import type { Client, TextChannel, ThreadChannel } from "npm:discord.js@14.14.1";
import type { SessionThreadManager } from "./session-threads.ts";
import type { WorkspaceManager } from "../core/workspace-manager.ts";

export interface CatchupMessage {
  id: string;
  content: string;
  createdAt: Date;
}

const CATCHUP_PREFIX = "offline-catchup";

export type CatchupAction = "process" | "ignore";

export interface DecodedCatchupId {
  action: CatchupAction;
  channelId: string;
  oldestId: string;
  newestId: string;
}

export function encodeCatchupCustomId(
  action: CatchupAction,
  channelId: string,
  oldestId: string,
  newestId: string,
): string {
  return CATCHUP_PREFIX + ":" + action + ":" + channelId + ":" + oldestId + ":" + newestId;
}

export function decodeCatchupCustomId(customId: string): DecodedCatchupId | null {
  if (!customId.startsWith(CATCHUP_PREFIX + ":")) return null;
  const parts = customId.split(":");
  if (parts.length !== 5) return null;
  const [, action, channelId, oldestId, newestId] = parts;
  if (action !== "process" && action !== "ignore") return null;
  return { action, channelId, oldestId, newestId };
}

export function isCatchupCustomId(customId: string): boolean {
  return customId.startsWith(CATCHUP_PREFIX + ":");
}

export function formatMergedPrompt(messages: CatchupMessage[]): string {
  const header =
    `[这是你离线期间用户在该 thread/频道累积发送的 ${messages.length} 条消息，按时间顺序排列。请综合判断如何处理：]`;
  const body = messages
    .map((m, i) => `${i + 1}. (${m.createdAt.toISOString()}) ${m.content}`)
    .join("\n");
  return `${header}\n\n${body}`;
}

export function pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const r = queue.shift();
    if (r) r();
  };
  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          next();
        }
      };
      if (active < n) run();
      else queue.push(run);
    });
  };
}

const FETCH_LIMIT = 100;
const FETCH_CONCURRENCY = 5;

export interface CatchupTarget {
  channelId: string;
  kind: "thread" | "workspace";
  lastActivityMs: number;
}

export interface MissedBatch {
  target: CatchupTarget;
  channel: TextChannel | ThreadChannel;
  messages: CatchupMessage[];
  oldestId: string;
  newestId: string;
}

export interface OfflineCatchupDeps {
  client: Client;
  sessionThreads: SessionThreadManager;
  workspaceManager: WorkspaceManager;
}

export class OfflineCatchupManager {
  constructor(private deps: OfflineCatchupDeps) {}

  collectTargets(): CatchupTarget[] {
    const targets: CatchupTarget[] = [];

    for (const meta of this.deps.sessionThreads.getAllSessionThreads()) {
      if (meta.sessionId.startsWith("pending_")) continue;
      const live = this.deps.sessionThreads.getThread(meta.sessionId);
      if (!live) continue;
      targets.push({
        channelId: meta.threadId,
        kind: "thread",
        lastActivityMs: meta.lastActivity.getTime(),
      });
    }

    for (const channelId of this.deps.workspaceManager.getManagedChannelIds()) {
      if (targets.some((t) => t.channelId === channelId)) continue;
      targets.push({ channelId, kind: "workspace", lastActivityMs: 0 });
    }

    targets.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    return targets;
  }

  async resolveChannel(
    target: CatchupTarget,
  ): Promise<TextChannel | ThreadChannel | null> {
    if (target.kind === "thread") {
      const sessionId = this.deps.sessionThreads.findSessionByThreadId(target.channelId);
      if (sessionId) {
        const ch = this.deps.sessionThreads.getThread(sessionId);
        if (ch) return ch;
      }
    }
    for (const guild of this.deps.client.guilds.cache.values()) {
      try {
        const fetched = await guild.channels.fetch(target.channelId);
        if (fetched && (fetched.isTextBased() || fetched.isThread())) {
          return fetched as unknown as TextChannel | ThreadChannel;
        }
      } catch {
        // try next guild
      }
    }
    return null;
  }

  async fetchMissed(
    target: CatchupTarget,
    channel: TextChannel | ThreadChannel,
  ): Promise<MissedBatch | null> {
    const sessionId = target.kind === "thread"
      ? this.deps.sessionThreads.findSessionByThreadId(target.channelId)
      : undefined;
    const bookmark = target.kind === "thread"
      ? (sessionId ? this.deps.sessionThreads.getLastSeenMessageId(sessionId) : undefined)
      : this.deps.workspaceManager.getLastSeenMessageId(target.channelId);

    if (!bookmark) {
      try {
        const latest = await channel.messages.fetch({ limit: 1 });
        const newest = latest.first();
        if (newest) {
          await this.advanceBookmark(target, newest.id);
        }
      } catch (err) {
        console.warn("[OfflineCatchup] Baseline fetch failed for " + target.channelId + ":", err);
      }
      return null;
    }

    let fetched;
    try {
      fetched = await channel.messages.fetch({ after: bookmark, limit: FETCH_LIMIT });
    } catch (err) {
      console.warn("[OfflineCatchup] Catch-up fetch failed for " + target.channelId + ":", err);
      return null;
    }

    const ourBotId = this.deps.client.user?.id;
    const filtered = Array.from(fetched.values())
      .filter((m) => !m.author.bot)
      .filter((m) => !m.content.startsWith("/"))
      .filter((m) => {
        if (m.mentions.users.size === 0) return true;
        const mentionsMe = ourBotId ? m.mentions.users.has(ourBotId) : false;
        const mentionsOtherBot = m.mentions.users.some((u) => u.bot && u.id !== ourBotId);
        return !(mentionsOtherBot && !mentionsMe);
      })
      .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));

    if (filtered.length === 0) return null;

    return {
      target,
      channel,
      messages: filtered.map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt })),
      oldestId: filtered[0].id,
      newestId: filtered[filtered.length - 1].id,
    };
  }

  private async advanceBookmark(target: CatchupTarget, messageId: string): Promise<void> {
    if (target.kind === "thread") {
      const sessionId = this.deps.sessionThreads.findSessionByThreadId(target.channelId);
      if (sessionId) this.deps.sessionThreads.setLastSeenMessageId(sessionId, messageId);
    } else {
      this.deps.workspaceManager.setLastSeenMessageId(target.channelId, messageId);
      await this.deps.workspaceManager.saveToDisk();
    }
  }

  async scanAll(): Promise<MissedBatch[]> {
    const targets = this.collectTargets();
    const limit = pLimit(FETCH_CONCURRENCY);
    const tasks = targets.map((t) =>
      limit(async () => {
        const channel = await this.resolveChannel(t);
        if (!channel) return null;
        return await this.fetchMissed(t, channel);
      })
    );
    const results = await Promise.all(tasks);
    return results.filter((r): r is MissedBatch => r !== null);
  }
}
