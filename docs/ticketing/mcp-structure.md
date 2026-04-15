# Ticketing MCP Overview

This document explains how the ticketing MCP is structured, how to install and run the MCP server, and how to use the agent-side MCP client configuration to test the integration.

## What is the MCP here?

The ticketing MCP is a local helper process that exposes authenticated ticketing operations to an MCP-compatible agent. The server runs locally, obtains OAuth2 tokens via PKCE, and forwards requests through the Kong gateway to the ticketing APIs.

The agent-side client is not a separate npm package in this repo. The "client" is the MCP-compatible agent configuration in `.claude/mcp.json`, which tells the agent how to launch the local MCP server.

## MCP structure

- `packages/ticketing-mcp-server/` — the local MCP server package.
- `packages/ticketing-mcp-server/src/index.ts` — starts the MCP server, registers tools, and attaches stdio transport.
- `packages/ticketing-mcp-server/src/auth/` — handles OAuth2 Authorization Code + PKCE, browser login, callback handling, refresh token flow, and secure local token storage.
- `packages/ticketing-mcp-server/src/client/api-client.ts` — makes authenticated requests through Kong, injects the Bearer token, and refreshes tokens automatically.
- `packages/ticketing-mcp-server/src/tools/` — domain-specific tool adapters for events, seats, orders, and payments.
- `.claude/mcp.json` — agent-side config that tells an MCP-compatible client how to launch the server.

## Install and run the MCP server

```bash
cd packages/ticketing-mcp-server
pnpm install
pnpm build
export TICKETING_API_URL=http://localhost:8000
pnpm dev
```

The compiled entry point is `packages/ticketing-mcp-server/dist/index.js`.

## Agent client configuration

The project includes a ready-to-use agent config at `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "ticketing": {
      "type": "stdio",
      "command": "node",
      "args": ["packages/ticketing-mcp-server/dist/index.js"],
      "env": {
        "TICKETING_API_URL": "http://localhost:8000"
      }
    }
  }
}
```

This config is discovered automatically by Claude Code and other MCP-compatible clients when the workspace is opened.

## Test the MCP integration

1. Start the local Docker Compose stack if it is not already running.
2. Build and run the MCP server as shown above.
3. Open the repo in your MCP-compatible agent (for example, Claude Code).
4. Ask the agent to call one of the ticketing tools, such as `search_events` or `list_my_orders`.

### Example test flow

```bash
# terminal 1: start the local platform and MCP server
cd packages/ticketing-mcp-server
pnpm install
pnpm build
export TICKETING_API_URL=http://localhost:8000
pnpm dev

# terminal 2: verify a service and agent prompt
cd services/auth-service
pnpm test
pnpm test:integration
```

## Agent prompt guidance

Use precise directory paths and explicit commands.

- `change directory into packages/ticketing-mcp-server and start the MCP server`
- `change directory into services/auth-service and run pnpm test and pnpm test:integration`
- `once the MCP server is running, use the agent to call search_events for upcoming events`
- `invoke the agent to list_my_orders and then get_order for a specific order id`

## MCP tool functionality

The server exposes authenticated ticketing tools that map to gateway endpoints:

- `search_events`
- `get_event`
- `view_seat_availability`
- `list_my_orders`
- `get_order`
- `create_order`
- `create_seated_order`
- `cancel_order`
- `get_payment`
- `pay_for_order`
- `revoke_oauth_session`

All calls are routed through Kong at `TICKETING_API_URL`, and the server uses the stored OAuth2 tokens to authenticate as the current user.
