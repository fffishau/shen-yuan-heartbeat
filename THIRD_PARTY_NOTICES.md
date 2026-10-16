# Third-party notices

## MCP App Message Bridge

Protocol flow and listener lifecycle were adapted from:

- Project: `wynsyl1014/mcp-app-message-bridge`
- Source: https://github.com/wynsyl1014/mcp-app-message-bridge
- License: MIT
- Used for: reserve/deliver/release lifecycle, `ui/update-model-context` followed by `ui/message`, App-only queue tools, and failure recovery guidance.

This project adds owner-specific heartbeat policy, Cloudflare D1 persistence, OAuth, Bark delivery, life-event authorization boundaries, cost controls, and Shen Yuan continuity rules; those are not supplied by the reference repository.

## Model Context Protocol SDK

- Package: `@modelcontextprotocol/sdk`
- Source: https://github.com/modelcontextprotocol/typescript-sdk
- Used for: MCP server and Streamable HTTP transport.

## Cloudflare Workers

- Wrangler and Cloudflare Workers/D1 APIs are used for local development and the optional deployment target.
