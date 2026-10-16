import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/types.js";

const emptyEnv = {} as Env;

describe("MCP OAuth CORS", () => {
  it("exposes the OAuth challenge to browser-based MCP clients", async () => {
    const response = await worker.fetch(
      new Request("https://heartbeat.example/mcp", { method: "POST" }),
      emptyEnv,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://heartbeat.example/.well-known/oauth-protected-resource"',
    );
    const exposed = response.headers
      .get("access-control-expose-headers")
      ?.toLowerCase();
    expect(exposed).toContain("www-authenticate");
    expect(exposed).toContain("mcp-session-id");
  });

  it.each([
    "/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/oauth/token",
    "/oauth/register",
  ])("allows browser preflights for %s", async (pathname) => {
    const response = await worker.fetch(
      new Request(`https://heartbeat.example${pathname}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://chatgpt.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
      emptyEnv,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain(
      "www-authenticate",
    );
  });

  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
  ])("serves GET %s with CORS", async (pathname) => {
    const response = await worker.fetch(
      new Request(`https://heartbeat.example${pathname}`),
      emptyEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
