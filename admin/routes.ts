/**
 * Admin API route handlers.
 * Pure functions that take deps and return Response objects.
 */

import { ChannelType, type Client } from "npm:discord.js@14.14.1";
import type { WorkspaceManager } from "../core/workspace-manager.ts";
import type { SessionThreadManager } from "../discord/session-threads.ts";

export interface AdminDeps {
  workspaceManager: WorkspaceManager;
  sessionThreadManager: SessionThreadManager;
  discordClient: Client;
  botStartTime: number;
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
  const categoryId = defaultChannel && 'parentId' in defaultChannel ? defaultChannel.parentId : null;

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

export async function updateWorkspace(deps: AdminDeps, name: string, req: Request): Promise<Response> {
  const existing = deps.workspaceManager.findByName(name);
  if (!existing) {
    return json({ error: `Workspace "${name}" not found` }, 404);
  }

  const body = await req.json();
  const updated = {
    name: existing.name,
    path: body.path ?? existing.path,
    channelId: body.channelId ?? existing.channelId,
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
  return json({ ok: true, removed });
}

// ─── Sessions ─────────────────────────────────────────

export function listSessions(deps: AdminDeps): Response {
  const sessions = deps.sessionThreadManager.getAllSessionThreads().map((s) => ({
    sessionId: s.sessionId,
    threadId: s.threadId,
    threadName: s.threadName,
    createdAt: s.createdAt.toISOString(),
    lastActivity: s.lastActivity.toISOString(),
    messageCount: s.messageCount,
  }));
  return json(sessions);
}

export async function cleanupSessions(deps: AdminDeps, req: Request): Promise<Response> {
  let maxAgeMs = 24 * 3_600_000; // default 24h
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
    .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));

  return json(channels);
}
