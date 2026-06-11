/**
 * Admin API route handlers.
 * Pure functions that take deps and return Response objects.
 */

import { ChannelType, type Client } from "npm:discord.js@14.14.1";
import type { WorkspaceManager } from "../core/workspace-manager.ts";
import type { SessionThreadManager } from "../discord/session-threads.ts";
import type { ScheduledTaskStore, TaskScheduler } from "../cron/index.ts";

export interface AdminDeps {
  workspaceManager: WorkspaceManager;
  sessionThreadManager: SessionThreadManager;
  discordClient: Client;
  botStartTime: number;
  hotQueryConfig?: { enabled: boolean; idleMs: number; maxSessions: number };
  scheduledTaskStore?: ScheduledTaskStore;
  taskScheduler?: TaskScheduler;
  /** Interrupt a running session by threadId (abort controller + hot query interrupt) */
  stopSessionByThreadId?: (threadId: string) => Promise<boolean>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Status ───────────────────────────────────────────

export function getStatus(deps: AdminDeps): Response {
  const { discordClient, botStartTime, workspaceManager, sessionThreadManager } = deps;
  const guild = discordClient.guilds.cache.first();

  return json({
    uptime: Date.now() - botStartTime,
    botUser: discordClient.user?.tag ?? null,
    guild: guild ? { id: guild.id, name: guild.name, memberCount: guild.memberCount } : null,
    managedChannels: [...workspaceManager.getManagedChannelIds()],
    workspaceCount: workspaceManager.list().length,
    sessionCount: sessionThreadManager.getAllSessionThreads().length,
    hotQueryConfig: deps.hotQueryConfig ?? null,
  });
}

// ─── Workspaces ───────────────────────────────────────

export function listWorkspaces(deps: AdminDeps): Response {
  return json(deps.workspaceManager.list());
}

export async function createWorkspace(deps: AdminDeps, req: Request): Promise<Response> {
  const body = await req.json();
  const { name, path } = body;

  if (!name || !path) {
    return json({ error: "name and path are required" }, 400);
  }

  if (deps.workspaceManager.findByName(name)) {
    return json({ error: `Workspace "${name}" already exists` }, 409);
  }

  // Validate path exists
  try {
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) {
      return json({ error: `Path is not a directory: ${path}` }, 400);
    }
  } catch {
    return json({ error: `Path does not exist: ${path}` }, 400);
  }

  // Create a new channel for this workspace
  const guild = deps.discordClient.guilds.cache.first();
  if (!guild) {
    return json({ error: "Bot is not connected to any guild" }, 500);
  }

  // Place under the same category as the default channel
  const defaultChannelId = [...deps.workspaceManager.getManagedChannelIds()][0];
  const defaultChannel = defaultChannelId ? guild.channels.cache.get(defaultChannelId) : null;
  const categoryId = defaultChannel && "parentId" in defaultChannel
    ? defaultChannel.parentId
    : null;

  let channelId: string;
  try {
    const { sanitizeChannelName } = await import("../discord/utils.ts");
    const channel = await guild.channels.create({
      name: sanitizeChannelName(name),
      type: ChannelType.GuildText,
      ...(categoryId && { parent: categoryId }),
      topic: `Workspace: ${name} | Path: ${path}`,
    });
    channelId = channel.id;
  } catch (err) {
    return json({ error: `Failed to create channel: ${err}` }, 500);
  }

  deps.workspaceManager.add({ name, path, channelId });
  await deps.workspaceManager.saveToDisk();
  return json({ ok: true, workspace: { name, path, channelId } }, 201);
}

export async function updateWorkspace(
  deps: AdminDeps,
  name: string,
  req: Request,
): Promise<Response> {
  const existing = deps.workspaceManager.findByName(name);
  if (!existing) {
    return json({ error: `Workspace "${name}" not found` }, 404);
  }

  const body = await req.json();
  const updated = {
    name: existing.name,
    path: body.path ?? existing.path,
    channelId: body.channelId ?? existing.channelId,
    autoThread: typeof body.autoThread === "boolean" ? body.autoThread : existing.autoThread,
  };

  if (body.path) {
    try {
      const stat = await Deno.stat(body.path);
      if (!stat.isDirectory) {
        return json({ error: `Path is not a directory: ${body.path}` }, 400);
      }
    } catch {
      return json({ error: `Path does not exist: ${body.path}` }, 400);
    }
  }

  deps.workspaceManager.add(updated);
  await deps.workspaceManager.saveToDisk();
  return json({ ok: true, workspace: updated });
}

export async function deleteWorkspace(deps: AdminDeps, name: string): Promise<Response> {
  const removed = deps.workspaceManager.remove(name);
  if (!removed) {
    return json({ error: `Workspace "${name}" not found` }, 404);
  }
  await deps.workspaceManager.saveToDisk();

  // Delete the Discord channel
  const guild = deps.discordClient.guilds.cache.first();
  if (guild) {
    try {
      const channel = guild.channels.cache.get(removed.channelId);
      if (channel) await channel.delete(`Workspace "${name}" removed`);
    } catch (err) {
      console.warn(`[Workspace] Failed to delete channel ${removed.channelId}:`, err);
    }
  }

  return json({ ok: true, removed });
}

// ─── Sessions ─────────────────────────────────────────

export function listSessions(deps: AdminDeps): Response {
  const { sessionThreadManager, workspaceManager, discordClient } = deps;
  const guild = discordClient.guilds.cache.first();

  const sessions = sessionThreadManager.getAllSessionThreads().map((s) => {
    // Resolve the parent channel of the thread, then map to a workspace.
    let parentChannelId: string | null = null;
    const thread = sessionThreadManager.getThread(s.sessionId);
    if (thread) {
      parentChannelId = (thread as unknown as { parentId: string | null }).parentId ?? null;
    } else if (guild) {
      // Fall back to fetching from cache by threadId
      const ch = guild.channels.cache.get(s.threadId);
      if (ch && "parentId" in ch) parentChannelId = ch.parentId;
    }

    const workspace = parentChannelId ? workspaceManager.findByChannel(parentChannelId) : undefined;

    return {
      sessionId: s.sessionId,
      threadId: s.threadId,
      threadName: s.threadName,
      createdAt: s.createdAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      messageCount: s.messageCount,
      hotQuery: s.hotQuery,
      workspaceName: workspace?.name ?? null,
      workspacePath: workspace?.path ?? null,
      channelId: parentChannelId,
    };
  });
  return json(sessions);
}

export async function cleanupSessions(deps: AdminDeps, req: Request): Promise<Response> {
  let maxAgeMs = 72 * 3_600_000; // default 72h
  try {
    const body = await req.json();
    if (body.maxAgeMs && typeof body.maxAgeMs === "number") {
      maxAgeMs = body.maxAgeMs;
    }
  } catch {
    // empty body is fine, use default
  }

  const removed = deps.sessionThreadManager.cleanup(maxAgeMs);
  return json({ ok: true, removed });
}

export async function refreshSessions(deps: AdminDeps): Promise<Response> {
  const guild = deps.discordClient.guilds.cache.first();
  if (!guild) {
    return json({ error: "No guild available" }, 500);
  }

  const allSessions = deps.sessionThreadManager.getAllSessionThreads();
  let removed = 0;
  const toRemove: string[] = [];

  for (const s of allSessions) {
    try {
      const fetched = await guild.channels.fetch(s.threadId);
      if (!fetched || !fetched.isThread()) {
        toRemove.push(s.sessionId);
      }
    } catch {
      toRemove.push(s.sessionId);
    }
  }

  for (const id of toRemove) {
    deps.sessionThreadManager.deleteSession(id);
    removed++;
  }

  return json({ ok: true, removed, total: allSessions.length });
}

export async function toggleSessionHotQuery(
  deps: AdminDeps,
  sessionId: string,
  req: Request,
): Promise<Response> {
  const session = deps.sessionThreadManager.getSessionThread(sessionId);
  if (!session) {
    return json({ error: "Session not found" }, 404);
  }
  const body = await req.json();
  const enabled: boolean | undefined = body.enabled === null ? undefined : !!body.enabled;
  deps.sessionThreadManager.setHotQuery(sessionId, enabled);
  return json({ ok: true, sessionId, hotQuery: enabled });
}

export async function deleteSession(deps: AdminDeps, sessionId: string): Promise<Response> {
  const threadId = deps.sessionThreadManager.deleteSession(sessionId);
  if (!threadId) {
    return json({ error: "Session not found" }, 404);
  }

  // Try to delete the Discord thread as well
  let threadDeleted = false;
  try {
    const channel = await deps.discordClient.channels.fetch(threadId);
    if (channel) {
      await channel.delete();
      threadDeleted = true;
    }
  } catch {
    // Thread may already be deleted in Discord — that's fine
  }

  return json({ ok: true, threadId, threadDeleted });
}

// ─── Channels ─────────────────────────────────────────

export function listChannels(deps: AdminDeps): Response {
  const guild = deps.discordClient.guilds.cache.first();
  if (!guild) {
    return json([]);
  }

  const channels = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText)
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      category: ch.parent?.name ?? null,
    }))
    .sort((a, b) =>
      (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name)
    );

  return json(channels);
}

// ─── Scheduled Tasks ─────────────────────────────────

export function listScheduledTasks(deps: AdminDeps): Response {
  if (!deps.scheduledTaskStore) return json([]);
  const tasks = deps.scheduledTaskStore.getAll();
  const logs = deps.scheduledTaskStore.getAllLogs(200);
  const enriched = tasks.map((t) => {
    const taskLogs = logs.filter((l) => l.taskId === t.id);
    const lastLog = taskLogs[taskLogs.length - 1];
    return {
      ...t,
      lastRunAt: lastLog?.runAt ?? null,
      lastRunStatus: lastLog?.status ?? null,
    };
  });
  return json(enriched);
}

export function getScheduledTaskDetail(deps: AdminDeps, taskId: string): Response {
  if (!deps.scheduledTaskStore) return json({ error: "Scheduler not available" }, 503);
  const task = deps.scheduledTaskStore.getById(taskId);
  if (!task) return json({ error: "Task not found" }, 404);

  const workspace = deps.workspaceManager.findByName(task.workspaceName);
  const logs = deps.scheduledTaskStore.getLogsForTask(taskId, 200);
  const totalRuns = logs.length;
  const successRuns = logs.filter((l) => l.status === "success").length;
  const lastLog = logs[logs.length - 1];

  return json({
    ...task,
    workspacePath: workspace?.path ?? null,
    channelId: workspace?.channelId ?? null,
    nextRunAt: computeNextRun(task),
    totalRuns,
    successRuns,
    failedRuns: totalRuns - successRuns,
    lastRunAt: lastLog?.runAt ?? null,
    lastRunStatus: lastLog?.status ?? null,
  });
}

function computeNextRun(task: { schedule: any; enabled: boolean }): string | null {
  if (!task.enabled) return null;
  const { schedule } = task;
  const now = new Date();

  if (schedule.type === "daily" && schedule.time) {
    const [h, m] = schedule.time.split(":").map(Number);
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (schedule.type === "weekly" && schedule.time && schedule.weekdays?.length) {
    const [h, m] = schedule.time.split(":").map(Number);
    for (let offset = 0; offset < 8; offset++) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(h, m, 0, 0);
      if (candidate > now && schedule.weekdays.includes(candidate.getDay())) {
        return candidate.toISOString();
      }
    }
  }

  if (schedule.type === "interval" && schedule.intervalHours) {
    const next = new Date(now.getTime() + schedule.intervalHours * 3_600_000);
    return next.toISOString();
  }

  return null;
}

export async function createScheduledTask(deps: AdminDeps, req: Request): Promise<Response> {
  if (!deps.scheduledTaskStore) return json({ error: "Scheduler not available" }, 503);

  const body = await req.json();
  const { workspaceName, command, schedule, threadName, enabled } = body;

  if (!workspaceName || !command || !schedule) {
    return json({ error: "workspaceName, command, and schedule are required" }, 400);
  }

  if (!deps.workspaceManager.findByName(workspaceName)) {
    return json({ error: `Workspace "${workspaceName}" not found` }, 404);
  }

  const task = {
    id: crypto.randomUUID(),
    workspaceName,
    command,
    schedule,
    enabled: enabled !== false,
    threadName: threadName || undefined,
    createdAt: new Date().toISOString(),
  };

  deps.scheduledTaskStore.add(task);
  await deps.scheduledTaskStore.saveTasks();
  return json(task, 201);
}

export async function updateScheduledTask(
  deps: AdminDeps,
  taskId: string,
  req: Request,
): Promise<Response> {
  if (!deps.scheduledTaskStore) return json({ error: "Scheduler not available" }, 503);

  const existing = deps.scheduledTaskStore.getById(taskId);
  if (!existing) return json({ error: "Task not found" }, 404);

  const body = await req.json();
  const patch: Record<string, unknown> = {};

  if (body.workspaceName !== undefined) {
    if (!deps.workspaceManager.findByName(body.workspaceName)) {
      return json({ error: `Workspace "${body.workspaceName}" not found` }, 404);
    }
    patch.workspaceName = body.workspaceName;
  }
  if (body.command !== undefined) patch.command = body.command;
  if (body.schedule !== undefined) patch.schedule = body.schedule;
  if (body.threadName !== undefined) patch.threadName = body.threadName || undefined;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  deps.scheduledTaskStore.update(taskId, patch);
  await deps.scheduledTaskStore.saveTasks();
  return json({ ok: true, task: deps.scheduledTaskStore.getById(taskId) });
}

export async function deleteScheduledTask(deps: AdminDeps, taskId: string): Promise<Response> {
  if (!deps.scheduledTaskStore) return json({ error: "Scheduler not available" }, 503);

  const removed = deps.scheduledTaskStore.remove(taskId);
  if (!removed) return json({ error: "Task not found" }, 404);

  await deps.scheduledTaskStore.saveTasks();
  return json({ ok: true });
}

export async function runScheduledTask(deps: AdminDeps, taskId: string): Promise<Response> {
  if (!deps.taskScheduler) return json({ error: "Scheduler not available" }, 503);

  try {
    const log = await deps.taskScheduler.runNow(taskId);
    return json(log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 400);
  }
}

export function getScheduledTaskLogs(deps: AdminDeps, taskId: string): Response {
  if (!deps.scheduledTaskStore) return json([]);
  return json(deps.scheduledTaskStore.getLogsForTask(taskId));
}

export async function stopScheduledTaskThread(
  deps: AdminDeps,
  threadId: string,
): Promise<Response> {
  if (!deps.stopSessionByThreadId) {
    return json({ error: "Stop handler not available" }, 503);
  }
  const stopped = await deps.stopSessionByThreadId(threadId);
  if (!stopped) {
    return json({ error: "No active session found for this thread" }, 404);
  }
  return json({ ok: true, threadId });
}
