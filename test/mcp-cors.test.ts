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
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("allows OAuth registration preflights", async () => {
    const response = await worker.fetch(
      new Request("https://heartbeat.example/oauth/register", {
        method: "OPTIONS",
        headers: {
          origin: "https://chatgpt.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
      emptyEnv,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("serves protected-resource metadata with CORS", async () => {
    const response = await worker.fetch(
      new Request(
        "https://heartbeat.example/.well-known/oauth-protected-resource/mcp",
      ),
      emptyEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
