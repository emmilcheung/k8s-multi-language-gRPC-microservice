# Ticketing MCP Server

An MCP (Model Context Protocol) server for the ticketing platform that runs locally and exposes AI-agent-friendly tools for searching events, managing orders, and processing payments.

## Features

- OAuth2 Authorization Code with PKCE for secure authentication
- Local token storage in `~/.config/ticketing-mcp/tokens.json` (mode 0o600)
- Automatic token refresh with fallback to re-authentication
- MCP tools for:
  - Event search and details (`search_events`, `get_event`)
  - Seat availability (`view_seat_availability`)
  - Order management (`list_my_orders`, `get_order`, `create_order`, `create_seated_order`, `cancel_order`)
  - Payments (`get_payment`, `pay_for_order`)

## Installation

```bash
pnpm install
pnpm build
```

Or with npm:

```bash
npm install
npm run build
```

## Usage

### Environment Variables

- `TICKETING_API_URL` — Base URL for the ticketing API (default: `http://localhost:8000`)

### Running the Server

```bash
export TICKETING_API_URL=http://localhost:8000
pnpm dev
```

Or run the compiled version:

```bash
node dist/index.js
```

### Authentication

The first time you run any MCP tool, the server will open your browser to authenticate via OAuth2. The callback URL is `http://127.0.0.1:19836/callback`.

After authentication, your token is stored locally at `~/.config/ticketing-mcp/tokens.json` with restrictive permissions (0o600).

## Testing

- `pnpm test` — run the MCP server package test suite.
- Ensure the local ticketing stack is available at `http://localhost:8000` before starting the server.
- Start the MCP server and then invoke the agent using `.claude/mcp.json`.
- Example agent prompt: `search_events and return the first available event name`.

## MCP Structure

The MCP server is structured to keep authentication, API client logic, and agent-facing tools separate.

- `src/index.ts` — MCP server startup, tool registration, and stdio integration.
- `src/auth/` — OAuth2 PKCE flow, browser login, refresh token handling, and secure local token storage.
- `src/client/api-client.ts` — Bearer token injection, request retry / refresh logic, and gateway calls to Kong.
- `src/tools/` — Tool adapters for domains such as events, seats, orders, and payments.
- `.claude/mcp.json` — Agent-side configuration used by Claude Code or any MCP-compatible client to launch the server.

This package is the MCP server host. The client is the agent configuration in `.claude/mcp.json`; there is no separate compiled client binary in this repository. The `.claude/mcp.json` file tells a compatible agent how to launch the server and use the exposed tool set.

## Architecture

### Token Management (`src/auth/token-store.ts`)

- `readTokens()` — Load tokens from disk
- `writeTokens(tokens)` — Save tokens with mode 0o600
- `isExpired(tokens)` — Check if token needs refresh (30s skew)
- `clearTokens()` — Wipe tokens

### OAuth Flow (`src/auth/oauth-flow.ts`)

- `login(apiBaseUrl)` — PKCE Authorization Code flow
  - Generates code verifier & challenge
  - Opens browser at `/oauth/authorize`
  - Listens for callback on localhost:19836
  - Exchanges code for tokens
- `refreshTokens(apiBaseUrl, refreshToken)` — Refresh expired tokens

### API Client (`src/client/api-client.ts`)

- Handles Bearer token injection in all requests
- Automatic token refresh on 401 or expiry
- Graceful fallback to re-authentication on refresh failure
- Methods: `get<T>(path)`, `post<T>(path, body)`, `delete<T>(path)`

### MCP Tools

Organized by domain:

- **events** (`src/tools/events.ts`) — `search_events`, `get_event`
- **seats** (`src/tools/seats.ts`) — `view_seat_availability`
- **orders** (`src/tools/orders.ts`) — `list_my_orders`, `get_order`, `create_order`, `create_seated_order`, `cancel_order`
- **payments** (`src/tools/payments.ts`) — `get_payment`, `pay_for_order`

## Development

### Type-checking

```bash
pnpm tsc --noEmit
```

### Building

```bash
pnpm build
```

Output goes to `dist/`.

## API Endpoints (via Kong Gateway)

All calls go through `TICKETING_API_URL` with `Authorization: Bearer <token>` header.

- `GET /api/tickets` — List events
- `GET /api/tickets/:id` — Get event
- `GET /api/seating-plans/:id/availability` — Seat availability
- `GET /api/orders` — List user orders
- `GET /api/orders/:id` — Get order
- `POST /api/orders` — Create GA order
- `POST /api/orders/seated` — Create seated order
- `DELETE /api/orders/:id` — Cancel order
- `GET /api/payments/:id` — Get payment
- `POST /api/payments` — Process payment

## License

UNLICENSED
