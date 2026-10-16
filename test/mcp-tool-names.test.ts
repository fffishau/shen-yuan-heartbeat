import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES } from "../src/mcp-tool-names.js";

describe("MCP tool names", () => {
  it("uses unique ChatGPT-compatible names", () => {
    const names = Object.values(MCP_TOOL_NAMES);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/u);
    }
  });
});
