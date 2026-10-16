import { loadConfig } from "./config.js";
import { secretMatches } from "./crypto.js";
import { HeartbeatService } from "./heartbeat.js";
import { handleMcp } from "./mcp.js";
import {
  authorizeMcp,
  handleOAuth,
  mcpUnauthorized,
  revokeAllMcpTokens,
} from "./oauth.js";
import type { Env } from "./types.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const oauth = await handleOAuth(request, env);
      if (oauth) return oauth;

      const url = new URL(request.url);
      if (request.method === "OPTIONS" && url.pathname === "/mcp") {
        return withCors(new Response(null, { status: 204 }));
      }
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "shen-yuan-heartbeat", version: "0.1.1" });
      }
      if (url.pathname === "/mcp") {
        if (!(await authorizeMcp(request, env))) return mcpUnauthorized(request);
        return withCors(await handleMcp(request, env));
      }
      if (url.pathname.startsWith("/api/")) {
        if (!(await adminAuthorized(request, env))) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return handleAdminApi(request, env);
      }
      if (url.pathname === "/") return landingPage();
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("request_failed", error instanceof Error ? error.message : String(error));
      return Response.json(
        { error: "internal_error", message: safeError(error) },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const service = new HeartbeatService(env, loadConfig(env));
    await service.schedulerTick();
  },
} satisfies ExportedHandler<Env>;

async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const service = new HeartbeatService(env, loadConfig(env));
  if (url.pathname === "/api/status" && request.method === "GET") {
    return Response.json(await service.status(), noStore());
  }
  if (url.pathname === "/api/audit" && request.method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    return Response.json({ entries: await service.audit(limit) }, noStore());
  }
  if (url.pathname === "/api/tick" && request.method === "POST") {
    return Response.json(await service.schedulerTick(), noStore());
  }
  if (url.pathname === "/api/control" && request.method === "POST") {
    const input = (await request.json()) as Record<string, unknown>;
    if (
      !["heartbeat", "push", "life-events"].includes(String(input.control)) ||
      typeof input.enabled !== "boolean"
    ) {
      return Response.json({ error: "invalid_control" }, { status: 400 });
    }
    return Response.json(
      await service.control(
        input.control as "heartbeat" | "push" | "life-events",
        input.enabled,
        "admin-api",
      ),
      noStore(),
    );
  }
  if (url.pathname === "/api/initialize" && request.method === "POST") {
    const input = (await request.json()) as Record<string, unknown>;
    if (typeof input.nextWakeAt !== "string") {
      return Response.json({ error: "nextWakeAt_required" }, { status: 400 });
    }
    return Response.json(
      await service.initializeSchedule(input.nextWakeAt, "admin-api"),
      noStore(),
    );
  }
  if (url.pathname === "/api/interaction" && request.method === "POST") {
    const input = (await request.json()) as Record<string, unknown>;
    if (typeof input.at !== "string" || typeof input.source !== "string") {
      return Response.json({ error: "at_and_source_required" }, { status: 400 });
    }
    return Response.json(
      await service.recordInteraction(input.at, input.source),
      noStore(),
    );
  }
  if (url.pathname === "/api/revoke-mcp" && request.method === "POST") {
    await revokeAllMcpTokens(env);
    return Response.json({ revoked: true }, noStore());
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  const token = /^Bearer\s+(.+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  return secretMatches(token, env.ADMIN_TOKEN);
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, mcp-session-id, last-event-id, mcp-protocol-version",
  );
  headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function noStore(): ResponseInit {
  return { headers: { "cache-control": "no-store" } };
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replaceAll(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]").slice(0, 500);
}

function landingPage(): Response {
  return new Response(
    `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>沉淵自主心跳</title><style>body{font:16px/1.6 system-ui;margin:0;background:#f5f2ea;color:#2c2924}main{max-width:680px;margin:8vh auto;padding:28px;background:#fff;border-radius:18px}code{background:#eee9df;padding:2px 6px;border-radius:5px}</style><main><h1>沉淵自主心跳</h1><p>服務已啟動。管理狀態需使用私人 MCP 連線或帶有管理權杖的 <code>/api/status</code>。</p><p>這個 Worker 不會自行生成沉淵的親密訊息；只有官方 ChatGPT 回合提交的決策才能進入 Bark 發送流程。</p><p><a href="/health">Health check</a></p></main></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
