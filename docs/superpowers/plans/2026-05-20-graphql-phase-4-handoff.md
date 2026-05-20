# Phase 4 Handoff Plan — Client GraphQL Migration + Remaining Resolvers

**Branch:** `feat/client-graphql-foundation` (keep open — do not merge until all tasks done).
**Goal:** Finish Phase 4.1–4.7 (client refactor), 3 remaining subgraph resolvers (order, venue, attendance), Phase 5 (lockdown), and validation.

Phase 1 (client foundation) and most of Phase 2/3 (SDL + resolvers for user, auth, ticket, payment) are already done in this branch. Foundation files exist:

- `services/client/lib/graphql-client.ts` (hardened, retry + trace + cookie forward; no PQ exchange yet — defer to Phase 5)
- `services/client/lib/graphql/execute.ts` (`executeQuery`, `executeMutation`)
- `services/client/codegen.ts` + `scripts/fetch-schema.ts` (local-fallback codegen against `services/apollo-router/supergraph.graphql`)
- `services/client/eslint.config.mjs` (graphql-eslint + no-inline-gql ban)
- `services/client/lib/graphql/operations/order/OrderDetail.graphql` (canary; pattern to follow)
- `services/apollo-router/supergraph.graphql` (recomposed with all Phase 2 SDL extensions)

## Ground rules for the executor

1. **Never write `gql\`...\`` template literals or query strings in `.ts`/`.tsx`.** All operations live in `services/client/lib/graphql/operations/<domain>/<OperationName>.graphql`. ESLint blocks the violation.
2. **After adding/editing any `.graphql` operation, run `pnpm codegen`** in `services/client/`. Types land in `lib/graphql/generated/`.
3. **Server Components / Server Actions only.** Don't introduce browser-side urql except for Phase 4.6 (seat selection) which is documented as a client-component exception.
4. **Preserve `serverApi()` REST keep-list:** `/api/users/signin|signup|signout`, `/api/auth/refresh`, `/api/payments/webhook`, `/oauth/consent/*`. Do NOT migrate these to GraphQL — federation spec forbids it.
5. **Every mutation resolver call from the client must go through Kong** (existing `executeMutation` already does this).
6. **For each migrated page/action, delete the now-unused REST URL helper** in `lib/api.ts` only if no other caller remains. Run `grep -r "the-removed-url"` first.
7. **No new dependencies** without justification. urql + graphql-codegen already installed.
8. **Run after every domain PR:** `pnpm lint && pnpm tsc --noEmit && pnpm test`. E2E (`pnpm test:e2e`) at end of Phase 4.
9. **Match existing code style.** Re-use `getValidAccessToken()` and cookie-forwarding patterns already in `lib/server-utils.ts` and `lib/graphql/execute.ts`.

## Pattern to follow (already shipped — copy this shape)

**Operation file** — `services/client/lib/graphql/operations/order/OrderDetail.graphql`:

```graphql
query OrderDetail($id: ID!) {
  order(id: $id) {
    id
    status
    # ...
  }
}
```

**Server Component usage** — `app/orders/[orderId]/page.tsx`:

```ts
import { OrderDetailDocument } from "@/lib/graphql/generated/graphql";
import { executeQuery } from "@/lib/graphql/execute";

const { data, error } = await executeQuery(OrderDetailDocument, { id: orderId }, { cookie });
```

**Server Action mutation** — `app/actions/orders.ts` (pattern to apply when migrating):

```ts
import { CreateOrderDocument } from "@/lib/graphql/generated/graphql";
import { executeMutation } from "@/lib/graphql/execute";

const { data, error } = await executeMutation(CreateOrderDocument, { input }, { cookie });
if (error) return { error: error.message };
return { data: data.createOrder };
```

---

## Phase 4.1 — Settings page → GraphQL

**Files to read first:**
- `services/client/app/settings/page.tsx` — currently 4–6 `serverApi()` calls.
- `services/client/app/actions/settings.ts` — REST PUT mutations.
- `services/apollo-router/supergraph.graphql` — confirms `User.profile/preferences/billingAddress`, `sessions`, `paymentMethods`, `orders`, `updateProfile`, `updatePreferences`, `updateBillingAddress`, `setDefaultPaymentMethod`, `deletePaymentMethod`, `revokeSession` are all in the supergraph.

**New operation files** in `lib/graphql/operations/settings/`:
- `SettingsPage.graphql` — single combined query: `currentUser { profile { displayName locale timezone } preferences { marketingOptIn orderUpdates productUpdates } billingAddress { line1 city country ... } } sessions { id userAgent ipAddress createdAt lastUsedAt current } paymentMethods { id brand last4 expMonth expYear isDefault label } orders(first: 20) { ... }` — collapses 6 REST calls into one.
- `UpdateProfile.graphql` (mutation, vars `$input: UpdateProfileInput!`).
- `UpdatePreferences.graphql` (mutation, vars `$input: UpdatePreferencesInput!`).
- `UpdateBillingAddress.graphql` (mutation, vars `$input: BillingAddressInput!`).
- `SetDefaultPaymentMethod.graphql` (mutation, vars `$id: ID!`).
- `DeletePaymentMethod.graphql` (mutation, vars `$id: ID!`).
- `RevokeSession.graphql` (mutation, vars `$id: ID!`).

**Edit:** `app/settings/page.tsx` — replace `Promise.all([serverApi(...)x6])` with one `executeQuery(SettingsPageDocument, {}, { cookie })`. Map fields from the typed response.

**Edit:** `app/actions/settings.ts` — replace each `serverApi('PUT', ...)` with `executeMutation`. Keep the existing Zod input validation; transform Zod-validated object into the GraphQL input shape.

**Verify:** `pnpm lint && pnpm tsc --noEmit && pnpm test`. Manually load the settings page in `pnpm dev`.

---

## Phase 4.2 — Tickets browse + detail → GraphQL

**Files:**
- `app/page.tsx` (home — uses `GET /api/tickets?available=true`).
- `app/tickets/[ticketId]/page.tsx` — ticket detail + seating plan.

**Operations** in `lib/graphql/operations/ticket/`:
- `TicketsBrowse.graphql` — `query TicketsBrowse($first: Int, $after: String) { ticketsConnection(filter: { availableOnly: true }, first: $first, after: $after) { edges { node { id title price available ticketType } cursor } pageInfo { hasNextPage endCursor } } }`.
- `TicketDetail.graphql` — `query TicketDetail($id: ID!) { ticket(id: $id) { id title price quota available maxPerUser ticketType seatingPlan { id } } }`.

**Edit pages.** Replace `serverApi` calls. For home, render the Connection edges. Note: the legacy `tickets: [Ticket!]!` query is still in the schema — prefer `ticketsConnection` going forward.

---

## Phase 4.3 — Orders list + payment → GraphQL

**Files:**
- `app/orders/page.tsx` — list.
- `app/orders/[orderId]/page.tsx` — extend existing `OrderDetail.graphql` to add `payment { id status amount currency }` (federation edge resolved by payment-service via `orderId`; already in supergraph after the contract-unblock fix).
- `app/actions/orders.ts` — `createOrder`, `cancelOrder`, `submitPayment`.

**Operations:**
- `OrdersList.graphql` — `query OrdersList { orders { id status totalCents createdAt ... } }`.
- Extend `OrderDetail.graphql` with `payment { ... }` selection.
- `CreateOrder.graphql` — mutation matching existing `createOrder(input: CreateOrderInput!)`.
- `CancelOrder.graphql` — mutation matching `cancelOrder(id: ID!)`.
- `CreatePayment.graphql` — mutation matching `createPayment(input: CreatePaymentInput!)`. (Note: the new `createSeatedOrder` mutation needs an order-service resolver — see "Remaining resolvers" below; defer this PR's seated-order migration until that resolver lands.)

---

## Phase 4.4 — Payment methods registration → GraphQL

**Files:**
- `app/actions/orders.ts` — payment-method-register flow (or wherever it lives).

**Operation:** `RegisterPaymentMethod.graphql` mutation. Input shape `RegisterPaymentMethodInput { providerPaymentMethodId, setAsDefault, consentAccepted, consentVersion }` — already in the supergraph.

**Important:** Pass the Stripe `paymentMethodId` from the browser as `providerPaymentMethodId`. The consent context (`x-consent-source`, `user-agent`, `x-forwarded-for`) is read by the resolver from request headers — the client doesn't need to send it explicitly. Make sure the action forwards these headers via `executeMutation`'s context (cookies + standard headers already forwarded; if `x-consent-source` is set elsewhere, propagate it).

---

## Phase 4.5 — Venues + seating plans → GraphQL  ⚠ blocked

**Blocked by:** Resolver work in venue-service against the corrected SDL (see "Remaining resolvers" below). Do not start Phase 4.5 until venue-service resolvers exist and supergraph is recomposed.

**Files (once unblocked):**
- `app/venues/page.tsx`, `app/venues/[venueId]/page.tsx`, `app/venues/[venueId]/edit/page.tsx`, `app/venues/[venueId]/plans/new/page.tsx`, `app/venues/[venueId]/plans/[planId]/page.tsx`.
- `app/actions/venues.ts`.

**Operations** in `lib/graphql/operations/venue/`:
- `VenuesList.graphql`, `VenueDetail.graphql`, `SeatingPlansList.graphql`, `SeatingPlanDetail.graphql`.
- Mutations: `CreateVenue`, `UpdateVenue`, `CreateSection`, `UpdateSection`, `CreateSeatingPlan`, `UpdateSeatingPlan`, `ActivateSeatingPlan`, `DeactivateSeatingPlan`, `CreatePriceTier`.

**Contract notes:**
- `createSeatingPlan` requires `ticketId`.
- `VenueSection.capacity` is derived from `rowCount` / `columnCount`; do not add or expect a persisted field.
- Price-tier work should use `createPriceTier` semantics with `price: String!`.

---

## Phase 4.6 — Seat selection + holds (client component) ⚠ blocked

**Blocked by:** venue-service resolvers (specifically `holdSeats`, `releaseSeats`, `SeatingPlan.availability`).

**File:** `app/tickets/[ticketId]/seats/page.tsx`. Today this is a Client Component using `fetch()` to `/api/seating-plans/:id/availability|hold|release` — violates `AGENTS.md` (mutations must go through Kong).

**Plan:**
- Add `@urql/next` (or use the existing urql client through an `app/_lib/urql-client.tsx` Provider) for browser-side queries/mutations.
- All requests go through Kong's `/graphql` route (same gateway URL as Server Components, just from the browser).
- `HoldSeats.graphql` mutation + `ReleaseSeats.graphql` mutation + `SeatingPlanAvailability.graphql` query.
- `HoldSeats.graphql` should use the real response shape: `{ held, expiresAt }`.
- `ReleaseSeats.graphql` should accept `planId` + `seatIds` (not `holdId`).
- Replace `fetch()` calls with urql `useQuery`/`useMutation`.

**Polling, not subscriptions:** Phase 6 is the WS upgrade; for now poll every 5s using urql's `requestPolicy: 'network-only'` on a `useEffect` interval.

---

## Phase 4.7 — Attendance + scan → GraphQL  ⚠ blocked

**Blocked by:** attendance-service resolvers (see below).

**Files:** `app/scan/page.tsx`, `app/tickets/[ticketId]/admission/page.tsx`, `app/tickets/[ticketId]/attendance/page.tsx`, `app/actions/attendance.ts`.

**Operations:** `EventCheckins.graphql`, `EventAttendanceSummary.graphql`, `EventAttendanceSettings.graphql`, `ValidateScan.graphql`, `RecordCheckin.graphql`, `UpdateAttendancePolicy.graphql`.

---

## Remaining resolvers (Phase 2/3) — required before some Phase 4 PRs

### R1. order-service — `Order.payment` + `createSeatedOrder` (Spring Boot)

**Files:**
- SDL already updated: `services/order-service/src/main/resources/schema/schema.graphqls` — has `Order.payment: Payment` and `createSeatedOrder` mutation.
- Resolver: `services/order-service/src/main/java/com/ticketing/orders/graphql/OrderGraphqlController.java`.

**Work:**
- Add `@SchemaMapping(typeName = "Order", field = "payment")` returning a federation reference keyed by `orderId`: `Map.of("__typename", "Payment", "orderId", order.getId().toString())`. Do **not** add `paymentId` persistence to order-service for this branch.
- Add `@MutationMapping createSeatedOrder` — delegate to existing `OrderService.createSeated(...)` (the same call backing `POST /api/orders/seated`). Apply existing `UserIdInterceptor` for signature validation.
- Update `OrderGraphqlControllerTest` (mockito) with assertions for both new methods.
- Run `mvn -q test`.

### R2. venue-service — full CRUD (Go gqlgen)  ★ largest

**Files:**
- SDL already updated: `services/venue-service/internal/graphql/schema.graphqls`.
- Add `tools.go` if missing (model from `services/attendance-service/tools.go`); run `go run github.com/99designs/gqlgen generate` to populate `generated.go` + resolver stubs.
- Map gqlgen-generated stubs to existing service-layer methods in `internal/handler/` and `internal/service/`.

**Work:**
- Apply `WrapWithUserIDSignatureValidation` middleware to all new mutation resolvers.
- DataLoader-batch `Venue.sections`, `Venue.seatingPlans`, `SeatingPlan.sections`, `SeatingPlan.priceTiers` using `dataloadgen` (model from existing `ticketloader.go` in ticket-service).
- Implement `holdSeats` / `releaseSeats` by delegating to the existing seat-hold service with `planId` + `seatIds` inputs. Do not add a holdId-based release flow.
- Mutations: `createVenue`, `updateVenue`, `createSection`, `updateSection`, `createSeatingPlan`, `updateSeatingPlan`, `activateSeatingPlan`, `deactivateSeatingPlan`, `createPriceTier`, `holdSeats`, `releaseSeats`.
- Keep venue contract semantics aligned with the corrected SDL: `createSeatingPlan` requires `ticketId`, `HoldSeats` returns `{ held, expiresAt }`, `ReleaseSeats` accepts `planId` + `seatIds`, `VenueSection.capacity` is derived from row/column counts, and price tiers use string `price`.
- Queries: `venues`, `venue(id)`, `seatingPlans(venueId)`, `seatingPlan(id)`. (Existing `seatingPlan` should already work.)
- Run `go test ./...`.

### R3. attendance-service — extensions (Go gqlgen)

**Files:**
- SDL already updated: `services/attendance-service/internal/graphql/schema.graphqls`.
- `tools.go` already exists.

**Work:**
- Run `go run github.com/99designs/gqlgen generate` to refresh stubs.
- Implement `eventCheckins(eventId, first, after)`, `validateScan(token)`, `recordCheckin(input)`, `recordCheckinByUserId(input)`, `updateEventAttendanceSettings(eventId, input)`.
- Apply `WrapWithUserIDSignatureValidation` to all mutations.
- Delegate to existing handlers in `internal/handler/`.
- Run `go test ./...`.

### R4. Recompose supergraph after every resolver PR

```bash
cd services/apollo-router && rover supergraph compose --config supergraph-config.yaml --output supergraph.graphql
```

Commit the new `supergraph.graphql`. Re-run `pnpm codegen` in `services/client/` so types pick up new fields.

### Restart point after unblock

Resume the original execution order from:
1. Finish Task 1 checks and commit if not already committed.
2. Implement venue-service resolvers against the corrected SDL.
3. Recompose supergraph and rerun client codegen.
4. Continue Phase 4.1–4.7.

---

## Phase 5 — Cleanup + audit lockdown

1. **Narrow `lib/api.ts`** — keep only `signin`, `signup`, `signout`, `auth/refresh`. Delete other URL helpers if `grep` confirms no caller.
2. **Update `services/client/AGENTS.md`** — add a "Data fetching" section: "All application data is GraphQL via the federated gateway. REST is retained only for auth token issuance and the Stripe webhook. Operations live in `lib/graphql/operations/`. Never inline `gql`-tagged strings."
3. **Update `docs/03-api-design.md`** — record the GraphQL-driven outcome.
4. **Update `docs/15-agent-hard-stops.md`** — "never copy supergraph SDL into the client repo".
5. **Update `docs/16-session-progress-log.md`** — log the migration completion (date `2026-05-20` or current).
6. **Defer:** PQ enforcement, introspection-off, schema registry — flagged in the original revised plan as audit-readiness items but not required for this PR. Leave a `TODO(audit)` comment near `lib/graphql-client.ts` referencing the original plan section §1.4.

---

## Phase 6 — Full validation + commit prep

**Per-package checks (run in each touched service dir):**
- TypeScript services (auth, user, payment, client): `pnpm lint && pnpm tsc --noEmit && pnpm test`.
- Go services (ticket, venue, attendance): `go vet ./... && go test -short ./...`.
- Spring service (order): `mvn -q test`.

**Client E2E:**
- `pnpm test:e2e` from `services/client/` — currently 18/18; must stay green.

**Compose smoke:**
- `docker compose up` from repo root; manually walk: browse → ticket → seat → order → pay → admission.

**Commit:**
- Per Conventional Commits: one commit per domain (e.g. `feat(client): migrate settings page to GraphQL`, `feat(venue-service): add venue/plan resolvers`).
- **Do not auto-merge to main.** Per `CLAUDE.md` rule: after branch is committed and tests pass, stop and request explicit owner approval before merge.

---

## Open risks

- **Codegen freshness:** After every supergraph recompose, the client must re-run `pnpm codegen`. If skipped, `pnpm tsc --noEmit` will fail loudly — that's the safety net.
- **`tickets` legacy field removal:** Don't remove the legacy `tickets: [Ticket!]!` query from `ticket-service` SDL in this branch. Migrate clients to `ticketsConnection` first; legacy removal is a follow-up.
- **Seated-order availability:** `createSeatedOrder` requires order-service resolver (R1) + venue-service `holdSeats` (R2). Don't ship Phase 4.3's seated path until both resolvers are merged.
- **N+1 risk:** Any time you add a list field that traverses entities (e.g. `Venue.seatingPlans`), apply DataLoader before merging. Watch for `[gqlgen] N+1` warnings in resolver tests.
- **Browser urql exception (4.6):** Document it explicitly in `services/client/AGENTS.md` so it doesn't get flagged as a regression by future reviewers.

---

## Task list (executor should mirror in TaskCreate)

1. R1: order-service `Order.payment` + `createSeatedOrder` resolver
2. R2: venue-service CRUD resolvers (largest)
3. R3: attendance-service resolver extensions
4. Recompose supergraph after each of R1/R2/R3
5. Phase 4.1 settings → GraphQL
6. Phase 4.2 tickets browse + detail → GraphQL
7. Phase 4.3 orders list + payment → GraphQL (defer seated path until R1 done)
8. Phase 4.4 payment-method register → GraphQL
9. Phase 4.5 venues + plans → GraphQL (depends on R2)
10. Phase 4.6 seat selection (browser urql) — depends on R2
11. Phase 4.7 attendance + scan → GraphQL (depends on R3)
12. Phase 5 cleanup + AGENTS.md update
13. Phase 6 full validation + per-domain commits
