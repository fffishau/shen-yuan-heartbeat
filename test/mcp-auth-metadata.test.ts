import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";
import { MCP_TOOL_NAMES } from "../src/mcp-tool-names.js";
import type { Env } from "../src/types.js";

describe("MCP OAuth tool metadata", () => {
  it("marks every advertised tool as OAuth protected", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({} as Env);
    const client = new Client({ name: "metadata-probe", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(Object.values(MCP_TOOL_NAMES));
    for (const tool of tools) {
      expect(tool._meta?.securitySchemes, tool.name).toEqual([
        { type: "oauth2", scopes: [] },
      ]);
    }

    await client.close();
    await server.close();
  });
});
