# Ticketing MCP Server — Setup Guide

Connects Claude Code (or any MCP-compatible agent) to the ticketing platform as the authenticated user, using OAuth2 Authorization Code + PKCE. The agent never holds your password — it holds a short-lived Bearer token that it can refresh automatically.

---

## Prerequisites

1. Docker Compose stack running (`docker-compose up --build`)
2. auth-service accessible at `http://localhost:8000` (via Kong proxy)
3. Node.js 20+ on your machine
4. pnpm installed globally (`npm install -g pnpm`)

---

## Build the MCP Server

```bash
cd packages/ticketing-mcp-server
pnpm install
pnpm build
```

The compiled entry point lands at `packages/ticketing-mcp-server/dist/index.js`.

---

## Claude Code Configuration

The `.claude/mcp.json` file is already checked into the repository. Claude Code automatically discovers it when you open this project. No manual configuration is required.

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

The path in `args` is relative to the workspace root (the directory containing `.claude/`).

---

## First Use — OAuth Login

The first time Claude Code invokes a ticketing MCP tool, the server opens your default browser to the OAuth authorization page:

```
http://localhost:8000/oauth/authorize?...
```

Sign in with your Marquee account. The server completes the PKCE exchange in the background and stores your tokens locally. Subsequent invocations are silent.

---

## Token Storage

Tokens are persisted at:

```
~/.config/ticketing-mcp/tokens.json
```

The file is created with mode `600` (owner read/write only). The refresh token rotates on every refresh — the file is updated automatically. You do not need to manage it manually.

---

## Available Scopes

The `ticketing-mcp` client is pre-approved for the following scopes:

| Scope | Grants access to |
|---|---|
| `tickets:read` | Browse events and ticket listings |
| `orders:read` | View your orders |
| `orders:create` | Place new orders |
| `orders:cancel` | Cancel an existing order |
| `payments:read` | View your payment history |
| `payments:create` | Submit a payment for an order |
| `venues:read` | Read venue and seating-plan data |
| `seating:read` | Read seat availability |
| `seating:hold` | Hold seats during checkout |

The access token issued at login encodes only the scopes you approved. Kong enforces scope at the gateway boundary before requests reach any service.

---

## Revoking Access

**Via Claude Code** — ask the agent to call the `revoke_oauth_session` MCP tool.

**Via the API** (manual):

```bash
# Requires a valid session Bearer token
curl -X DELETE http://localhost:8000/oauth/clients/ticketing-mcp \
  -H "Authorization: Bearer <your-access-token>"
```

This invalidates all active sessions for the `ticketing-mcp` client tied to your account.

---

## Troubleshooting

**`Error: Cannot find module '.../dist/index.js'`**
Run `pnpm build` inside `packages/ticketing-mcp-server`. The dist directory is not committed.

**`ECONNREFUSED` connecting to `http://localhost:8000`**
The Docker Compose stack is not running, or Kong is still starting up. Run `docker-compose up` and wait for the Kong health check to pass.

**`TICKETING_API_URL` override**
If your Kong proxy runs on a different port, set the environment variable before starting Claude Code:

```bash
export TICKETING_API_URL=http://localhost:9000
```

Or update the `env` block in `.claude/mcp.json` for a permanent local override (do not commit that change).

**Browser does not open during OAuth login**
The server prints the authorization URL to stderr. Copy it manually into your browser to complete the flow.

**Token refresh fails with 401**
Your refresh token has expired (TTL: 24 hours). Delete `~/.config/ticketing-mcp/tokens.json` and re-authenticate by invoking any ticketing MCP tool.
