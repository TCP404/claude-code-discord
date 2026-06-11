/**
 * Admin HTTP server — Deno.serve() with simple URL routing.
 * Binds to 127.0.0.1 only for security.
 */

import type { Client } from "npm:discord.js@14.14.1";
import type { WorkspaceManager } from "../core/workspace-manager.ts";
import type { SessionThreadManager } from "../discord/session-threads.ts";
import type { ScheduledTaskStore, TaskScheduler } from "../cron/index.ts";
import { adminHtml } from "./html.ts";
import {
  type AdminDeps,
  cleanupSessions,
  createScheduledTask,
  createWorkspace,
  deleteScheduledTask,
  deleteSession,
  deleteWorkspace,
  getScheduledTaskDetail,
  getScheduledTaskLogs,
  getStatus,
  listChannels,
  listScheduledTasks,
  listSessions,
  listWorkspaces,
  refreshSessions,
  runScheduledTask,
  stopScheduledTaskThread,
  toggleSessionHotQuery,
  updateScheduledTask,
  updateWorkspace,
} from "./routes.ts";

export interface AdminServerOptions {
  workspaceManager: WorkspaceManager;
  sessionThreadManager: SessionThreadManager;
  discordClient: Client;
  botStartTime: number;
  port?: number;
  hotQueryConfig?: { enabled: boolean; idleMs: number; maxSessions: number };
  scheduledTaskStore?: ScheduledTaskStore;
  taskScheduler?: TaskScheduler;
  stopSessionByThreadId?: (threadId: string) => Promise<boolean>;
}

export function startAdminServer(options: AdminServerOptions): Deno.HttpServer | null {
  const port = options.port ?? (Number(Deno.env.get("ADMIN_PORT")) || 7860);
  const deps: AdminDeps = {
    workspaceManager: options.workspaceManager,
    sessionThreadManager: options.sessionThreadManager,
    discordClient: options.discordClient,
    botStartTime: options.botStartTime,
    hotQueryConfig: options.hotQueryConfig,
    scheduledTaskStore: options.scheduledTaskStore,
    taskScheduler: options.taskScheduler,
    stopSessionByThreadId: options.stopSessionByThreadId,
  };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Serve SPA
    if (path === "/" && method === "GET") {
      return new Response(adminHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // API routes
    if (path === "/api/status" && method === "GET") {
      return getStatus(deps);
    }

    if (path === "/api/workspaces" && method === "GET") {
      return listWorkspaces(deps);
    }
    if (path === "/api/workspaces" && method === "POST") {
      return await createWorkspace(deps, req);
    }

    // /api/workspaces/:name
    const wsMatch = path.match(/^\/api\/workspaces\/(.+)$/);
    if (wsMatch) {
      const name = decodeURIComponent(wsMatch[1]);
      if (method === "PUT") return await updateWorkspace(deps, name, req);
      if (method === "DELETE") return await deleteWorkspace(deps, name);
    }

    if (path === "/api/sessions" && method === "GET") {
      return listSessions(deps);
    }
    if (path === "/api/sessions/cleanup" && method === "POST") {
      return await cleanupSessions(deps, req);
    }
    if (path === "/api/sessions/refresh" && method === "POST") {
      return await refreshSessions(deps);
    }

    // /api/sessions/:id/hot-query
    const hotMatch = path.match(/^\/api\/sessions\/([^/]+)\/hot-query$/);
    if (hotMatch && method === "PUT") {
      const sessionId = decodeURIComponent(hotMatch[1]);
      return await toggleSessionHotQuery(deps, sessionId, req);
    }

    // /api/sessions/:id
    const sessMatch = path.match(/^\/api\/sessions\/(.+)$/);
    if (sessMatch && method === "DELETE") {
      const sessionId = decodeURIComponent(sessMatch[1]);
      return await deleteSession(deps, sessionId);
    }

    if (path === "/api/channels" && method === "GET") {
      return listChannels(deps);
    }

    // ─── Scheduled Tasks ─────────────────────────────────
    if (path === "/api/schedules" && method === "GET") {
      return listScheduledTasks(deps);
    }
    if (path === "/api/schedules" && method === "POST") {
      return await createScheduledTask(deps, req);
    }

    const schedMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
    if (schedMatch) {
      const taskId = decodeURIComponent(schedMatch[1]);
      if (method === "PUT") return await updateScheduledTask(deps, taskId, req);
      if (method === "DELETE") return await deleteScheduledTask(deps, taskId);
    }

    const schedDetailMatch = path.match(/^\/api\/schedules\/([^/]+)\/detail$/);
    if (schedDetailMatch && method === "GET") {
      const taskId = decodeURIComponent(schedDetailMatch[1]);
      return getScheduledTaskDetail(deps, taskId);
    }

    const schedRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/);
    if (schedRunMatch && method === "POST") {
      const taskId = decodeURIComponent(schedRunMatch[1]);
      return await runScheduledTask(deps, taskId);
    }

    const schedLogsMatch = path.match(/^\/api\/schedules\/([^/]+)\/logs$/);
    if (schedLogsMatch && method === "GET") {
      const taskId = decodeURIComponent(schedLogsMatch[1]);
      return getScheduledTaskLogs(deps, taskId);
    }

    const schedStopMatch = path.match(/^\/api\/threads\/([^/]+)\/stop$/);
    if (schedStopMatch && method === "POST") {
      const threadId = decodeURIComponent(schedStopMatch[1]);
      return await stopScheduledTaskThread(deps, threadId);
    }

    return new Response("Not Found", { status: 404 });
  };

  try {
    const server = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, handler);
    console.log(`Admin UI available at http://localhost:${port}`);
    return server;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Admin UI failed to start on port ${port}: ${msg}`);
    return null;
  }
}
