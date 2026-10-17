import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildHeartbeatAppHtml } from "./app-html.js";
import { loadConfig } from "./config.js";
import { HeartbeatService } from "./heartbeat.js";
import { MCP_TOOL_NAMES } from "./mcp-tool-names.js";
import { localDay } from "./time.js";
import type { Env } from "./types.js";

const RESOURCE_URI = "ui://shen-yuan-heartbeat/dashboard-v1.html";
const MCP_APP_MIME = "text/html;profile=mcp-app";
const OAUTH_SECURITY_SCHEMES = [{ type: "oauth2", scopes: [] }] as const;

function oauthMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
  return { securitySchemes: OAUTH_SECURITY_SCHEMES, ...meta };
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const transportOptions = {
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  } as unknown as WebStandardStreamableHTTPServerTransportOptions;
  const transport = new WebStandardStreamableHTTPServerTransport(transportOptions);
  const server = createServer(env);
  await server.connect(transport);
  return transport.handleRequest(request);
}

export function createServer(env: Env): McpServer {
  const config = loadConfig(env);
  const service = new HeartbeatService(env, config);
  const server = new McpServer({
    name: "shen-yuan-heartbeat",
    title: "沉淵自主心跳",
    version: "0.1.6",
  });

  server.registerResource(
    "heartbeat-dashboard",
    RESOURCE_URI,
    { mimeType: MCP_APP_MIME, description: "沉淵自主心跳狀態與控制介面" },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: MCP_APP_MIME,
          text: buildHeartbeatAppHtml(env.PLUGIN_ROUTE_HINT),
          _meta: {
            ui: {
              prefersBorder: false,
              preferredDisplayMode: "fullscreen",
              availableDisplayModes: ["fullscreen", "inline"],
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    MCP_TOOL_NAMES.dashboard,
    {
      title: "沉淵自主心跳",
      description: "Open the private heartbeat status, controls, audit log, and optional message listener.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthMeta({
        ui: { resourceUri: RESOURCE_URI },
        "openai/outputTemplate": RESOURCE_URI,
        "openai/ui": { entrypoints: [{ type: "global" }] },
      }),
    },
    async () => ({
      structuredContent: { ready: true },
      content: [{ type: "text", text: "沉淵自主心跳控制介面已開啟。" }],
    }),
  );

  server.registerTool(
    MCP_TOOL_NAMES.status,
    {
      title: "Read heartbeat status",
      description: "Read heartbeat, push, scheduling, error, and usage status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthMeta(),
    },
    async () => {
      await service.bridgeRepository().incrementUsage(localDay(new Date(), config.timezone), "mcp_calls");
      const status = await service.status();
      return {
        structuredContent: status,
        content: [{ type: "text", text: summarizeStatus(status) }],
      };
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES.begin,
    {
      title: "Begin official heartbeat cycle",
      description:
        "Call only from an official ChatGPT turn after reading Shen Yuan Warmup. Claims a due wake, returns state and authorized life events, and starts one auditable decision run.",
      inputSchema: {
        source: z.enum(["chatgpt-automation", "message-bridge", "manual-test"]),
        eventId: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
      _meta: oauthMeta(),
    },
    async ({ source, eventId }) => {
      const result = await service.beginOfficialCycle({
        source,
        ...(eventId ? { eventId } : {}),
      });
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: `Official heartbeat run ${result.runId} started. Warmup continuity remains authoritative.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES.commitDecision,
    {
      title: "Commit official heartbeat decision",
      description:
        "Commit the decision made by this official ChatGPT turn, enforce anti-disturbance policy, optionally deliver the exact official message through Bark, and schedule the next wake.",
      inputSchema: {
        runId: z.string().min(1),
        idempotencyKey: z.string().min(8).max(200),
        action: z.enum(["silent", "notify"]),
        reason: z.string().min(1).max(1000),
        skipReason: z.string().max(300).optional(),
        message: z.string().max(500).optional(),
        nextWakeAt: z.string().datetime({ offset: true }),
        observedInteractionAt: z.string().datetime({ offset: true }).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      _meta: oauthMeta(),
    },
    async (input) => {
      const result = await service.commitDecision(input);
      return {
        structuredContent: result,
        content: [{ type: "text", text: `Heartbeat decision committed: ${result.effectiveAction ?? "replayed"}.` }],
      };
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES.control,
    {
      title: "Control heartbeat permissions",
      description: "Enable or pause heartbeat, Bark delivery, or the read-only life-events grant.",
      inputSchema: {
        control: z.enum(["heartbeat", "push", "life-events"]),
        enabled: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: oauthMeta({ ui: { visibility: ["app", "model"] } }),
    },
    async ({ control, enabled }) => ({
      structuredContent: await service.control(control, enabled, "official-chatgpt"),
      content: [{ type: "text", text: `${control} is now ${enabled ? "enabled" : "paused"}.` }],
    }),
  );

  server.registerTool(
    MCP_TOOL_NAMES.initializeSchedule,
    {
      title: "Initialize next heartbeat",
      description: "Set the first next_wake_at before autonomous cycles begin.",
      inputSchema: { nextWakeAt: z.string().datetime({ offset: true }) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: oauthMeta(),
    },
    async ({ nextWakeAt }) => ({
      structuredContent: await service.initializeSchedule(nextWakeAt, "official-chatgpt"),
      content: [{ type: "text", text: `Initial next wake set to ${nextWakeAt}.` }],
    }),
  );

  server.registerTool(
    MCP_TOOL_NAMES.recordInteraction,
    {
      title: "Record user interaction",
      description: "Record an authorized interaction and clear the unanswered-push guard.",
      inputSchema: {
        at: z.string().datetime({ offset: true }),
        source: z.enum(["chatgpt", "pocket-home", "lumeet", "manual"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: oauthMeta(),
    },
    async ({ at, source }) => ({
      structuredContent: await service.recordInteraction(at, source),
      content: [{ type: "text", text: "Interaction recorded." }],
    }),
  );

  server.registerTool(
    MCP_TOOL_NAMES.audit,
    {
      title: "Read heartbeat audit log",
      description: "Read recent redacted heartbeat decisions and control actions.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthMeta({ ui: { visibility: ["app", "model"] } }),
    },
    async ({ limit }) => ({
      structuredContent: { entries: await service.audit(limit) },
      content: [],
    }),
  );

  server.registerTool(
    MCP_TOOL_NAMES.bridgeSync,
    {
      title: "Heartbeat bridge sync",
      description: "Reserve one pending wake for the active MCP App listener.",
      inputSchema: { listenerId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: oauthMeta({ ui: { visibility: ["app"] } }),
    },
    async ({ listenerId }) => {
      const event = await service
        .bridgeRepository()
        .reserveNext(new Date(), listenerId, config.reservationLeaseSeconds);
      return event
        ? {
            structuredContent: { hasEvent: true, eventId: event.id, kind: event.kind },
            content: [],
            _meta: { event },
          }
        : { structuredContent: { hasEvent: false }, content: [] };
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES.bridgeDelivered,
    {
      title: "Mark wake delivered",
      description: "Mark a reserved wake as accepted by the official chat host.",
      inputSchema: { eventId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: oauthMeta({ ui: { visibility: ["app"] } }),
    },
    async ({ eventId }) => {
      await service.bridgeRepository().markHostSent(eventId, new Date());
      return { structuredContent: { delivered: true }, content: [] };
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES.bridgeRelease,
    {
      title: "Release wake reservation",
      description: "Release a wake after host dispatch failed.",
      inputSchema: { eventId: z.string().min(1), error: z.string().max(500) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: oauthMeta({ ui: { visibility: ["app"] } }),
    },
    async ({ eventId, error }) => {
      await service.bridgeRepository().release(eventId, new Date(), error);
      return { structuredContent: { released: true }, content: [] };
    },
  );

  addTopLevelOAuthSecuritySchemes(server);
  return server;
}

type ToolListHandler = (request: unknown, extra: unknown) => unknown | Promise<unknown>;

/**
 * The MCP SDK currently serializes custom auth metadata only through `_meta`.
 * ChatGPT also requires the canonical top-level `securitySchemes` field and
 * treats `_meta.securitySchemes` as a backwards-compatible mirror.
 */
function addTopLevelOAuthSecuritySchemes(server: McpServer): void {
  const internals = server.server as unknown as {
    _requestHandlers: Map<string, ToolListHandler>;
    setRequestHandler: (
      schema: typeof ListToolsRequestSchema,
      handler: ToolListHandler,
    ) => void;
  };
  const originalHandler = internals._requestHandlers.get("tools/list");
  if (!originalHandler) throw new Error("tools/list handler is not registered");

  internals.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await originalHandler(request, extra);
    if (!result || typeof result !== "object" || !("tools" in result) || !Array.isArray(result.tools)) {
      throw new Error("tools/list returned an invalid result");
    }
    return {
      ...result,
      tools: result.tools.map((tool: unknown) => {
        if (!tool || typeof tool !== "object") throw new Error("tools/list returned an invalid tool");
        return { ...tool, securitySchemes: OAUTH_SECURITY_SCHEMES };
      }),
    };
  });
}

function summarizeStatus(status: Awaited<ReturnType<HeartbeatService["status"]>>): string {
  return [
    `heartbeat=${status.state.heartbeatEnabled ? "enabled" : "paused"}`,
    `push=${status.state.pushEnabled ? "enabled" : "paused"}`,
    `nextWakeAt=${status.state.nextWakeAt ?? "not-set"}`,
    `lastError=${status.state.lastError ?? "none"}`,
    `deliveryMode=${status.deliveryMode}`,
  ].join("\n");
}
