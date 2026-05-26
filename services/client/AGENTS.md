# client — Agent Guidelines

> Service-specific notes; defers to root [`/AGENTS.md`](../../AGENTS.md) on conflict.

---

## Service Identity

| Field | Value |
|---|---|
| **Role** | Browser-facing frontend — consumes all services via Kong API Gateway |
| **Language** | TypeScript / Node.js 24 LTS |
| **Framework** | Next.js 16 (App Router) |
| **Package manager** | pnpm 10 |
| **Test runner** | Vitest (unit) + Playwright (E2E) |
| **Styling** | Tailwind CSS + `class-variance-authority` |
| **UI primitives** | `@base-ui/react` |
| **Observability** | `@vercel/otel` (OpenTelemetry) |
| **Dev port** | 4000 (E2E tests require `pnpm dev --port 4000`) |

---

<!-- BEGIN:nextjs-agent-rules -->
## ⚠️  This is NOT the Next.js you know

This version has **breaking changes** — APIs, conventions, and file structure may all differ from your training data. **Read the relevant guide in `node_modules/next/dist/docs/` before writing any code.** Heed deprecation notices.

Key things that have changed or may surprise:
- `app/` directory with React Server Components is the default — avoid `pages/` patterns.
- `"use client"` / `"use server"` directives are required explicitly on boundaries.
- `fetch` is patched by Next.js for deduplication and caching — do not rely on standard fetch semantics.
- Server Actions replace many patterns that previously required API routes.
- `instrumentation.ts` runs on the server edge before any module — OTel is initialised there.
<!-- END:nextjs-agent-rules -->

---

## Quick Commands

```bash
# Install dependencies
pnpm install

# Run dev server (standard)
pnpm dev

# Run dev server on port 4000 (required for E2E tests)
pnpm dev --port 4000

# Run unit tests
pnpm test

# Run E2E tests (requires dev server on port 4000)
pnpm test:e2e

# Lint + type-check (must pass before push)
pnpm lint && pnpm tsc --noEmit

# Build for production
pnpm build
```

---

## Project Layout

```
app/                        ← Next.js App Router root
  layout.tsx                ← root layout (fonts, providers, global CSS)
  page.tsx                  ← home page (Server Component by default)
  (routes)/                 ← route groups (authentication-gated areas etc.)
components/                 ← shared React components
  ui/                       ← base-ui primitives + CVA variants
lib/                        ← server-side helpers, API client functions, validation schemas
__tests__/                  ← Vitest unit tests (component-level, lib functions)
tests/                      ← Playwright E2E tests
instrumentation.ts          ← OTel SDK bootstrap (runs before any module on the server)
next.config.ts              ← Next.js configuration
playwright.config.ts        ← E2E test configuration (base URL: http://localhost:4000)
```

---

## Data Fetching

The client uses **GraphQL as the primary data layer** via Apollo Router (supergraph). REST is kept only for a short keeplist where the GraphQL schema has gaps.

### GraphQL (default for all new work)

- **Server Components / Server Actions**: use `executeQuery` / `executeMutation` from `lib/graphql/execute.ts`.
- **Browser-side** (seat-map only, `app/tickets/[ticketId]/seats/`): use `urql` hooks (`useQuery`, `useMutation`) inside `UrqlProvider`.
- Operations live in `lib/graphql/operations/<domain>/<OperationName>.graphql`. **Never** write inline `gql` template literals in `.ts` / `.tsx`.
- After editing any `.graphql` file run `pnpm codegen` to regenerate `lib/graphql/generated/index.ts`.

### REST keep-list

Two categories:

**Permanent** — these will not move to GraphQL. Federation spec forbids it, or the wire format is fixed.

| Endpoint pattern | Why permanent |
|---|---|
| `POST /api/auth/signin` | Auth token exchange — sets refresh cookie, must be REST |
| `POST /api/auth/signup` | Auth token exchange |
| `POST /api/auth/signout` | Session teardown — cookie clear |
| `GET /api/auth/refresh` | Token refresh — cookie-bound |
| `POST /api/payments/webhook` | Stripe webhook — raw body + signature verification |
| `GET /api/oauth/consent` | OAuth redirect flow — browser navigation, not data fetch |

**Deferred** — schema gaps the venue-service migration (Stage R2) did not close. Each is migratable; none is architecturally necessary. Tracked for a follow-up SDL extension.

| Endpoint pattern | SDL gap | Closure cost |
|---|---|---|
| `GET /api/seating-plans/:id` | `SeatingPlan` missing `name`, `maxSeatsPerOrder`, `ticketId` fields | Cheap — extend type + resolver |
| `GET /api/seating-plans?venueId=` | Closes automatically once the above fields land (`seatingPlans(venueId:)` query already exists) | Cheap — same change |
| `GET /api/seating-plans/:id/availability` | No `AvailabilitySnapshot` aggregate type | Medium — new type + resolver |
| `GET /api/seating-plans/:id/price-tiers` | No `SeatingPlan.priceTiers` field / `priceTiers(planId:)` query | Cheap — add field + DataLoader |
| `GET /api/venues/:id/sections` | No `Venue.sections` field | Cheap — add field + DataLoader |
| `DELETE /api/venues/:id/sections/:sid` | No `deleteSection` mutation | Cheap — single mutation, service-layer delete exists |
| `POST /api/seating-plans/:id/sections` | No per-plan `addPlanSection` mutation (existing `createSection` adds VenueSection templates, not plan sections) | Medium — needs SDL design |
| `PATCH /api/seating-plans/:id/layout` | No `saveSeatingPlanLayout` mutation | Cheap — REST handler logic is portable |
| `POST /api/seating-plans` (venue-context) | `createSeatingPlan` SDL requires `ticketId`; venue admin creates draft plans before a ticket exists | Needs design call — either nullable `ticketId` or new `createDraftSeatingPlan` mutation |
Use `lib/api.ts:serverApi` for all keep-list REST calls. Do **not** add new domain-specific wrapper functions to `lib/api.ts` — call `serverApi` inline with the typed response.

---

## Next.js App Router Conventions

- **Server Components by default.** Only add `"use client"` where interactivity or browser APIs are genuinely required. Lean Server Components reduce bundle size.
- **Server Actions** (`"use server"`) replace direct API routes for form mutations. Every Server Action must validate input with Zod before processing.
- **Never expose service internals through the client.** All API calls to backend services go through Kong (`http://localhost:8000` locally). Do not call internal service ports directly from the browser.
- **Data fetching in Server Components** uses `fetch` with Next.js cache/revalidate semantics. Prefer `cache: 'no-store'` for user-specific data; set `revalidate` for shared catalogue data.
- **Route handlers** (`app/api/`) are used only when a Server Action is insufficient (e.g. Stripe webhooks, middleware-incompatible flows). Prefer Server Actions for mutations.
- **`Suspense` boundaries** must wrap any async Server Component that could be slow — never block an entire page on a slow fetch.

---

## Security — Frontend Rules

- **CSRF protection:** Server Actions are protected by Next.js's origin header check. Do not disable or bypass this check. For server-side `fetch` calls that proxy user data, include the forwarded `Cookie` or `Authorization` header (from the incoming request), never embed credentials as literals in code.
- **All mutations go to Kong** — never call a backend service directly from the browser, bypassing the gateway.
- **No secrets in client-side code** or `NEXT_PUBLIC_` env vars. Only non-sensitive config (public API base URL, analytics IDs) belongs in `NEXT_PUBLIC_`.
- **User input validated with Zod** before being passed to a Server Action or API route handler.
- **Content Security Policy** headers are configured in `next.config.ts` — do not weaken them without explicit review.
- **No `dangerouslySetInnerHTML`** with user-controlled data.

---

## Observability

- `instrumentation.ts` bootstraps the OTel SDK via `@vercel/otel`. This file runs on the server before any application module — do not move OTel initialisation elsewhere.
- W3C `traceparent` header is forwarded on `fetch` calls to Kong to propagate traces across services.
- No client-side tracing by default — add only if explicitly required.

---

## Testing

- **Unit tests** (`__tests__/`): test pure functions in `lib/`, component rendering with React Testing Library, and Server Action logic (mocked). Use `vitest` + `@testing-library/react`.
- **E2E tests** (`tests/`): Playwright tests covering critical user journeys (auth, ticket browsing, order + payment flow). These run against a live stack — ensure Docker Compose is up and the dev server is running on port 4000.
- E2E test status: **18/18 passing**.
- Test naming: `<subject> should <behaviour> when <condition>`.
- **No mocked network in E2E tests** — they exercise the real Kong → service stack.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_KONG_URL` | Public Kong proxy base URL (client-side) |
| `OTEL_SERVICE_NAME` | OTel service name (`client`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel Collector endpoint (server-side only) |

Use `.env.example` as the template. Never commit `.env`.

---

## Hard Stops (inherit from root)

See [§15 Agent Hard Stops](../../docs/15-agent-hard-stops.md). Key items for this service:

- Do **not** add any secret or token to a `NEXT_PUBLIC_` environment variable.
- Do **not** weaken CSP headers without explicit discussion.
- Do **not** add a new `pnpm` dependency without noting it and explaining why.
- Do **not** disable origin checking on Server Actions.

