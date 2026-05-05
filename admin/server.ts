/**
 * Admin HTTP server — Deno.serve() with simple URL routing.
 * Binds to 127.0.0.1 only for security.
 */

import type { Client } from "npm:discord.js@14.14.1";
import type { WorkspaceManager } from "../core/workspace-manager.ts";
import type { SessionThreadManager } from "../discord/session-threads.ts";
import { adminHtml } from "./html.ts";
import {
  type AdminDeps,
  cleanupSessions,
  createWorkspace,
  deleteSession,
  deleteWorkspace,
  getStatus,
  listChannels,
  listSessions,
  listWorkspaces,
  updateWorkspace,
} from "./routes.ts";

export interface AdminServerOptions {
  workspaceManager: WorkspaceManager;
  sessionThreadManager: SessionThreadManager;
  discordClient: Client;
  botStartTime: number;
  port?: number;
}

export function startAdminServer(options: AdminServerOptions): Deno.HttpServer | null {
  const port = options.port ?? (Number(Deno.env.get("ADMIN_PORT")) || 7860);
  const deps: AdminDeps = {
    workspaceManager: options.workspaceManager,
    sessionThreadManager: options.sessionThreadManager,
    discordClient: options.discordClient,
    botStartTime: options.botStartTime,
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

    // /api/sessions/:id
    const sessMatch = path.match(/^\/api\/sessions\/(.+)$/);
    if (sessMatch && method === "DELETE") {
      const sessionId = decodeURIComponent(sessMatch[1]);
      return await deleteSession(deps, sessionId);
    }

    if (path === "/api/channels" && method === "GET") {
      return listChannels(deps);
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
