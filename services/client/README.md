# client

Next.js 16 (App Router) front-end for the Ticketing Platform.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2 (App Router) |
| Language | TypeScript |
| UI | shadcn/ui + Tailwind CSS v4 |
| HTTP (server) | `fetch` with cookie forwarding |
| HTTP (client) | `axios` |
| Testing | Vitest + React Testing Library |
| Runtime | Node.js 24 |

## Routes

| Path | Description |
|---|---|
| `/` | Landing — lists all unreserved tickets |
| `/auth/signup` | Sign-up form |
| `/auth/signin` | Sign-in form |
| `/tickets/new` | Create a ticket (authenticated) |
| `/tickets/[ticketId]` | Ticket detail + purchase / edit |
| `/orders` | My orders list (authenticated) |
| `/orders/[orderId]` | Order detail + stub payment form |

## Environment variables

Copy `.env.example` to `.env` and fill in values.

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Browser-facing API gateway URL (e.g. `http://localhost:8080`) |
| `INTERNAL_API_URL` | Cluster-internal gateway URL for server-side fetches |
| `JWT_COOKIE_NAME` | Access-token cookie name (must match Kong and auth-service) |
| `REFRESH_COOKIE_NAME` | Refresh-token cookie name (must match auth-service) |
| `ACCESS_TOKEN_COOKIE_SAME_SITE` | Fallback SameSite policy for access cookie parsing |
| `REFRESH_TOKEN_COOKIE_SAME_SITE` | Fallback SameSite policy for refresh cookie parsing |
| `ACCESS_TOKEN_COOKIE_PATH` | Fallback path for access cookie parsing |
| `REFRESH_COOKIE_PATH` | Fallback path for refresh cookie parsing |
| `SESSION_REFRESH_SKEW_SECONDS` | Seconds before access-token expiry to trigger refresh |
| `NEXT_TELEMETRY_DISABLED` | Set to `1` to disable Next.js telemetry |

## Development

```bash
pnpm install
cp .env.example .env
pnpm dev          # starts on http://localhost:3000
```

Requires the shared `docker-compose.yml` at repo root to be running for Kong and backend services.

## Testing

```bash
pnpm test         # run once
pnpm test:watch   # watch mode
```

## Building

```bash
pnpm build        # outputs .next/standalone for Docker
```

## Docker

```bash
docker build -t ticketing/client:local .
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_API_URL=http://localhost:8080 \
  -e INTERNAL_API_URL=http://localhost:8080 \
  ticketing/client:local
```

## Port

`3000`
