import { describe, expect, it } from "vitest";
import { authorizeMcp, handleOAuth } from "../src/oauth.js";
import type { Env } from "../src/types.js";

type Row = Record<string, unknown> | null;

function fakeDb(firstRows: Row[] = []): D1Database {
  const rows = [...firstRows];
  const statement = {
    bind() {
      return statement;
    },
    async first<T>() {
      return (rows.shift() ?? null) as T | null;
    },
    async run() {
      return { success: true } as D1Result;
    },
  } as unknown as D1PreparedStatement;
  return {
    prepare() {
      return statement;
    },
    async batch<T>() {
      return [] as D1Result<T>[];
    },
  } as unknown as D1Database;
}

describe("OAuth refresh tokens", () => {
  it("preserves refresh_token in dynamic client registration", async () => {
    const env = { DB: fakeDb([{ count: 0 }]) } as Env;
    const response = await handleOAuth(
      new Request("https://heartbeat.example/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://chatgpt.com/aip/callback"],
          grant_types: ["authorization_code", "refresh_token"],
        }),
      }),
      env,
    );
    const registration = await response?.json() as { grant_types: string[] };

    expect(response?.status).toBe(201);
    expect(registration.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("exchanges a valid refresh token for a new access token", async () => {
    const env = {
      DB: fakeDb([{
        client_id: "client_test",
        scope: "heartbeat",
        expires_at: "2099-01-01T00:00:00.000Z",
        revoked_at: null,
      }]),
    } as Env;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "refresh_test-token",
      client_id: "client_test",
    });
    const response = await handleOAuth(
      new Request("https://heartbeat.example/oauth/token", { method: "POST", body }),
      env,
    );
    const token = await response?.json() as {
      access_token: string;
      token_type: string;
      scope: string;
    };

    expect(response?.status).toBe(200);
    expect(token.access_token).toBeTruthy();
    expect(token.access_token.startsWith("refresh_")).toBe(false);
    expect(token.token_type).toBe("Bearer");
    expect(token.scope).toBe("heartbeat");
  });

  it("never accepts a refresh token as an MCP bearer token", async () => {
    const env = { DB: fakeDb() } as Env;
    const authorized = await authorizeMcp(
      new Request("https://heartbeat.example/mcp", {
        headers: { authorization: "Bearer refresh_test-token" },
      }),
      env,
    );

    expect(authorized).toBe(false);
  });
});
