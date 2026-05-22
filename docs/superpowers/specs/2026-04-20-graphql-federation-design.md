# GraphQL Federation Design Spec

**Date:** 2026-04-20
**Status:** Draft
**Goal:** Add a federated GraphQL API layer alongside the existing REST/gRPC APIs, enabling flexible data querying for the Next.js frontend and external consumers.

## Context & Motivation

### Problem

1. **Schema coordination pain** — maintaining a 60KB OpenAPI spec across 3 languages (TypeScript, Go, Java) is manual and error-prone.
2. **External developer experience** — external consumers need a self-service, explorable API (introspection, schema documentation) rather than static OpenAPI docs.

### Approach chosen

**Apollo Federation v2** with distributed subgraph ownership. Each service manages its own GraphQL schema. Apollo Router composes them into a unified supergraph. Runs parallel to Kong (GraphQL is additive, REST remains unchanged).

### API standard exception

The current platform standard (`docs/03-api-design.md`, line 6) says: "Use REST + JSON for public/client-facing APIs." This spec introduces GraphQL as an **approved additional protocol** for client-facing APIs, not a replacement. REST remains the primary protocol. When this spec is approved, `docs/03-api-design.md` should be updated to add: "GraphQL (via Apollo Federation) is an approved alternative for flexible client queries. REST remains the default for new endpoints."

### Alternatives considered

| Approach | Why not |
|---|---|
| GraphQL Mesh (The Guild) | Centralizes schema ownership in the gateway — contradicts the goal of per-service schema ownership |
| WunderGraph Cosmo | Viable but smaller community (~10-20x smaller than Apollo); same effort as Apollo Federation |
| DGS monolithic gateway | Centralizes schema — same problem as Mesh |

---

## Architecture

```
                    ┌──────────────────────────────────────┐
                    │           Kong Gateway :8000         │
                    │  (JWT auth, rate limit, routing)      │
                    ├──────────┬───────────────────────────┤
                    │ /api/*   │ /graphql                  │
                    │ (REST)   │ (GraphQL)                 │
                    ▼          ▼                           │
              Existing    ┌────────────────────┐          │
              Services    │  Apollo Router     │          │
                          │  :4001 (internal)  │          │
                          │  Supergraph SDL    │          │
                          └────┬───┬───┬───┬───┘          │
                               │   │   │   │              │
          ┌────────────────────┘   │   │   └──────────┐   │
          ▼                        ▼   ▼              ▼   │
   ┌─────────────┐  ┌──────────────┐ ┌────────────┐ ┌────────────┐
   │auth-subgraph│  │ticket-subgr. │ │order-subgr.│ │venue-subgr.│
   │payment-subgr│  │  (gqlgen)    │ │(Spring GQL)│ │  (gqlgen)  │
   │user-subgraph│  │              │ │            │ │            │
   │  (NestJS)   │  └──────────────┘ └────────────┘ └────────────┘
   └─────────────┘
```

### Key decisions

- **Kong stays the single external entry point.** A new route `/graphql` proxies to Apollo Router on internal port 4001. Router is not externally reachable.
- **REST and GraphQL coexist permanently.** REST routes remain unchanged. GraphQL is additive.
- **Apollo Router trusts Kong's identity headers.** Kong injects `X-User-Id`, `X-User-Roles`, and `X-User-Id-Sig` after JWT validation. Router propagates all three — same trust model as existing services.
- **Subgraphs mount `/graphql` on each service's existing HTTP port.** No secondary ports needed.
- **Expiration-service excluded.** Pure async worker with no API surface.

---

## Subgraph Assignments

| Service | Language | GraphQL Library | Port | Entity Owned |
|---|---|---|---|---|
| auth-service | TypeScript/NestJS | `@nestjs/graphql` + `@apollo/subgraph` | 3000 | `User` (id, email) |
| user-service | TypeScript/NestJS | `@nestjs/graphql` + `@apollo/subgraph` | 3004 | Extends `User` (profile, preferences) |
| payment-service | TypeScript/NestJS | `@nestjs/graphql` + `@apollo/subgraph` | 3002 | `Payment` |
| ticket-service | Go/Echo | `gqlgen` + federation plugin | 3001 | `Ticket` |
| venue-service | Go/Echo | `gqlgen` + federation plugin | 3003 | `SeatingPlan`, `Section`, `Seat` |
| order-service | Java/Spring Boot | Spring GraphQL | 8082 | `Order`, `OrderLineItem` |

---

## Field-Level Authorization Policy

The GraphQL endpoint serves both the internal frontend and external consumers. PII
fields must not be available to arbitrary authenticated users. Authorization is
enforced at the **resolver level** in each subgraph (not in the Router).

### Authorization matrix

| Field | Visibility | Rule |
|---|---|---|
| `User.id` | Any authenticated user | Always returned for entity resolution |
| `User.email` | Self only | Resolver checks `X-User-Id == requested user ID` |
| `UserProfile.firstName`, `lastName` | Self only | Same self-check |
| `UserProfile.phone`, `billingAddress` | Self only | PII — never exposed to other users |
| `UserPreferences.*` | Self only | Private user data |
| `User.orders` | Self only | Resolver filters by `X-User-Id` |
| `Payment.*` | Self only (via order ownership) | Resolver verifies user owns the parent order |
| `Ticket.*` (public fields) | Any authenticated user | title, price, quota, available are catalog data |
| `Order.*` | Self only | Resolver checks `X-User-Id == order.userId` |
| `SeatingPlan.*`, `Section.*`, `Seat.*` | Any authenticated user | Catalog data (seat availability) |

### Implementation pattern

Each subgraph enforces authorization in its resolvers using the `X-User-Id` header:

```graphql
# Example: auth-service schema — email is self-only, nullable for auth gating
type User @key(fields: "id") {
  id: ID!
  email: String @tag(name: "self-only")
}
```

The `@tag` directive is documentation — actual enforcement is in the resolver.
Self-only fields MUST be nullable (`String`, not `String!`) so returning `null`
for unauthorized access is schema-legal and doesn't bubble a GraphQL execution error:

```typescript
// auth.resolver.ts
@ResolveField()
email(@Parent() user, @Context() ctx) {
  if (ctx.req.headers['x-user-id'] !== user.id) return null;
  return user.email;
}
```

Go and Java subgraphs use equivalent resolver-level checks.

---

## Entity Schema Design

### auth-service (owns `User`)

```graphql
type User @key(fields: "id") {
  id: ID!
  email: String @tag(name: "self-only")
}

type Query {
  currentUser: User
}
```

**Note:** `signup`, `signin`, and `signout` are excluded from the GraphQL schema.
These operations manage JWT cookie issuance and are inherently REST concerns — they
remain available at `/api/users/signup`, `/api/users/signin`, `/api/users/signout`
through Kong. Including them in a JWT-required GraphQL route would be contradictory
(you'd need a valid JWT to sign up).

### user-service (extends `User`)

```graphql
type User @key(fields: "id") {
  id: ID!
  profile: UserProfile @tag(name: "self-only")
  preferences: UserPreferences @tag(name: "self-only")
}

type UserProfile {
  firstName: String
  lastName: String
  phone: String @tag(name: "pii")
  billingAddress: String @tag(name: "pii")
}

type UserPreferences {
  notificationPreferences: JSON
}
```

### ticket-service (owns `Ticket`)

```graphql
type Ticket @key(fields: "id") {
  id: ID!
  title: String!
  price: Int!
  quota: Int!
  available: Int!
  maxPerUser: Int
  ticketType: TicketType!
  seatingPlan: SeatingPlan @provides(fields: "id")
  createdAt: DateTime!
  updatedAt: DateTime!
}

enum TicketType {
  GENERAL_ADMISSION
  SEATED
}

type Query {
  tickets: [Ticket!]!
  ticket(id: ID!): Ticket
}

type Mutation {
  createTicket(input: CreateTicketInput!): Ticket!
  updateTicket(id: ID!, input: UpdateTicketInput!): Ticket!
}
```

### venue-service (owns `SeatingPlan`)

```graphql
type SeatingPlan @key(fields: "id") {
  id: ID!
  sections: [Section!]!
  assignmentMode: AssignmentMode!
  status: PlanStatus!
}

type Section {
  id: ID!
  name: String!
  seats: [Seat!]!
  availableSeats: Int!
}

type Seat {
  id: ID!
  label: String!
  price: Int!
  status: SeatStatus!
}

enum AssignmentMode { MANUAL AUTO }
enum SeatStatus { AVAILABLE HELD SOLD }
enum PlanStatus { DRAFT ACTIVE ARCHIVED }
```

### order-service (owns `Order`, references `Ticket`, `Payment`, `User`)

```graphql
type Order @key(fields: "id") {
  id: ID!
  user: User!
  ticket: Ticket!
  payment: Payment
  quantity: Int!
  totalPrice: Int!
  status: OrderStatus!
  expiresAt: DateTime
  createdAt: DateTime!
}

type User @key(fields: "id") {
  id: ID!
  orders: [Order!]!
}

enum OrderStatus {
  PENDING
  AWAITING_PAYMENT
  COMPLETED
  CANCELLED
}

type Query {
  order(id: ID!): Order
  orders: [Order!]!
}

type Mutation {
  createOrder(input: CreateOrderInput!): Order!
  cancelOrder(id: ID!): Order!
}
```

### payment-service (owns `Payment`)

```graphql
type Payment @key(fields: "id") {
  id: ID!
  orderId: ID!
  amount: Int!
  currency: String!
  status: PaymentStatus!
  createdAt: DateTime!
}

enum PaymentStatus {
  PENDING
  CAPTURED
  FAILED
  REFUNDED
}

type Query {
  payment(id: ID!): Payment
}

type Mutation {
  createPayment(input: CreatePaymentInput!): Payment!
}
```

---

## Apollo Router Configuration

### Service: `services/apollo-router/`

```
services/apollo-router/
├── Dockerfile
├── router.yaml
├── supergraph-config.yaml
└── scripts/
    └── compose.sh
```

### `router.yaml`

```yaml
supergraph:
  path: /supergraph.graphql

headers:
  all:
    request:
      - propagate:
          named: x-user-id
      - propagate:
          named: x-user-roles
      - propagate:
          named: x-user-id-sig
      - propagate:
          named: traceparent
      - propagate:
          named: tracestate

listen: 0.0.0.0:4001

# Sandbox: controlled per environment via config overlay (see below).
sandbox:
  enabled: ${env.APOLLO_SANDBOX_ENABLED:-false}

telemetry:
  instrumentation:
    spans:
      mode: spec_compliant
  exporters:
    tracing:
      otlp:
        enabled: true
        endpoint: http://otel-collector:4317

limits:
  max_depth: 15
  max_height: 200
```

### `supergraph-config.yaml`

Uses file-based schema references for offline composition (see Composition Model section above).

```yaml
federation_version: =2.9
subgraphs:
  auth:
    routing_url: http://auth-service:3000/graphql
    schema:
      file: ../../services/auth-service/src/graphql/schema.graphql
  tickets:
    routing_url: http://ticket-service:3001/graphql
    schema:
      file: ../../services/ticket-service/internal/graphql/schema.graphqls
  orders:
    routing_url: http://order-service:8082/graphql
    schema:
      file: ../../services/order-service/src/main/resources/schema/schema.graphqls
  payments:
    routing_url: http://payment-service:3002/graphql
    schema:
      file: ../../services/payment-service/src/graphql/schema.graphql
  venues:
    routing_url: http://venue-service:3003/graphql
    schema:
      file: ../../services/venue-service/internal/graphql/schema.graphqls
  users:
    routing_url: http://user-service:3004/graphql
    schema:
      file: ../../services/user-service/src/graphql/schema.graphql
```

---

## Kong Integration

### New route in `kong.base.yml`

The `/graphql` route uses the same pattern as existing protected routes in this repo:
Kong's `jwt` plugin validates the token, then a `post-function` block (inlined from
`jwt-sub.lua` by `build.sh`) extracts claims and sets identity headers. This is NOT
a named plugin — it is Lua code rendered into the declarative config at build time.

```yaml
# New top-level service entry (same level as auth-service, ticket-service, etc.)
# In this repo, routes are nested under the service they proxy to.
- name: apollo-router
  url: http://apollo-router:4001
  connect_timeout: 5000
  read_timeout: 30000
  write_timeout: 10000
  routes:
    - name: graphql
      paths:
        - /graphql
      methods:
        - POST
        - OPTIONS
      strip_path: false
      plugins:
        - name: jwt
          config:
            key_claim_name: iss
            cookie_names: [{{JWT_COOKIE_NAME}}]
            header_names: [Authorization]
            claims_to_verify: [exp]
        - name: post-function
          config:
            access:
              - |
                {{JWT_SUB_LUA}}
        - name: cors
          config:
            origins: ["*"]
            methods: [POST, OPTIONS]
            headers: [Content-Type, Authorization]
            exposed_headers: [X-Request-Id]
            credentials: false
            max_age: 3600
        - name: rate-limiting
          config:
            minute: 60
```

**Note on Apollo Sandbox:** The Kong route only allows POST + OPTIONS (query
execution). Apollo Sandbox (the interactive explorer) requires GET and is served
by the Router itself. For local dev, set `APOLLO_SANDBOX_ENABLED=true` in the
Router's environment (see docker-compose entry below), then access Sandbox directly
at `http://localhost:4001` (Router port exposed in docker-compose, not through Kong).
Sandbox is disabled in non-local environments via the env var default.

**External developer experience:** GraphQL's self-documenting nature comes from
**introspection**, which works over POST through Kong like any other query.

- **Non-browser tools** (Postman, Insomnia, CLI clients): point at the Kong
  `/graphql` endpoint with an `Authorization: Bearer <JWT>` header.
- **Browser-hosted IDEs** (remote Apollo Sandbox at `sandbox.apollo.dev`,
  GraphiQL): also point at the Kong `/graphql` endpoint. These work because the
  route includes a CORS plugin allowing cross-origin POST with `Authorization`
  header. External consumers authenticate via `Authorization: Bearer <JWT>`, not
  cookies — cookies are first-party only and won't work cross-origin.

The CORS plugin sets `credentials: false` because external tooling uses Bearer
tokens, not cookies. The `jwt` plugin on the route already accepts both
`cookie_names` (for the Next.js frontend, same-origin) and `header_names:
[Authorization]` (for external consumers, cross-origin).

Introspection is enabled by default on the Router. It can be disabled in production
via `router.yaml` if the schema should not be publicly discoverable (in that case,
publish a static SDL export instead).

### Auth model

```
Client → Kong (JWT validation + jwt-sub.lua post-function)
       → X-User-Id, X-User-Roles, X-User-Id-Sig headers injected
       → Apollo Router (propagates all three)
       → Subgraphs (enforce auth using existing guards/middleware)
```

**Identity contract (3 headers):**
- `X-User-Id` — UUID from JWT `sub` claim
- `X-User-Roles` — comma-separated list from JWT `roles` claim (e.g., `organizer,buyer`)
- `X-User-Id-Sig` — HMAC-SHA256 signature for tamper detection (validated by order-service, ticket-service, venue-service)

**Security invariants:**
- Kong globally strips `X-User-Id` and `X-User-Roles` on all inbound requests (global `request-transformer` plugin) before any route plugin runs. This prevents header forgery.
- The `post-function` Lua block then sets these headers authoritatively after JWT validation.
- JWT is required on `/graphql`. Anonymous queries (e.g., browsing tickets) should use a separate unauthenticated route or the existing REST endpoints. This avoids the complexity of mixed auth/anon on a single route with PII-bearing fields.
- Subgraphs validate `X-User-Id-Sig` on mutations using existing `UserIdSignatureValidator` (Java), signature middleware (Go), or equivalent (NestJS).

---

## Per-Service Implementation Pattern

### TypeScript/NestJS (auth, payment, user)

**Dependencies:** `@nestjs/graphql`, `@nestjs/apollo`, `@apollo/subgraph`, `graphql`

**Structure:**
```
src/
├── auth/                    # existing REST module (unchanged)
│   ├── auth.controller.ts
│   └── auth.service.ts
├── graphql/                 # new
│   ├── schema.graphql       # subgraph SDL (service owns this)
│   └── auth.resolver.ts     # resolvers calling existing service layer
└── app.module.ts            # imports GraphQLModule with ApolloFederationDriver
```

**Module config:**
```typescript
GraphQLModule.forRoot<ApolloFederationDriverConfig>({
  driver: ApolloFederationDriver,
  typePaths: ['./src/graphql/*.graphql'],
  playground: false,
})
```

### Go/Echo (ticket, venue)

**Dependencies:** `github.com/99designs/gqlgen` with federation plugin

**Structure:**
```
internal/
├── handler/             # existing REST (unchanged)
├── grpc/                # existing gRPC (unchanged)
└── graphql/             # new
    ├── schema.graphqls  # subgraph SDL (service owns this)
    ├── resolver.go      # calls existing service layer
    ├── model.go         # generated
    └── generated.go     # generated
gqlgen.yml               # federation: { version: 2 }
```

**Mount:** `/graphql` route on existing Echo server, same port.

### Java/Spring Boot (order)

**Dependencies:** `org.springframework.boot:spring-boot-starter-graphql`, `com.apollographql.federation:federation-graphql-java-support`

> **Deviation from initial plan:** order-service uses Spring GraphQL (`@Controller` + `@QueryMapping`/`@SchemaMapping`) instead of Netflix DGS. Rationale: Spring-native, zero additional dependency, sufficient for federation via `@apollographql/federation-jvm`.

**Structure:**
```
src/main/
├── java/.../order/
│   ├── controller/          # existing REST (unchanged)
│   ├── grpc/                # existing gRPC clients (unchanged)
│   └── graphql/             # new
│       ├── OrderGraphqlController.java  # @Controller, @QueryMapping, @SchemaMapping
│       └── FederationConfig.java        # federation entity resolution config
├── resources/schema/
│   └── schema.graphqls      # subgraph SDL (service owns this)
```

### Common pattern

- Schema file (SDL) lives in the service repo — service team owns it.
- Resolvers call the existing service/domain layer — no business logic duplication.
- REST and gRPC endpoints remain unchanged.
- `/graphql` mounts on the existing HTTP server and port.

---

## Schema Composition Pipeline

### Composition model: prebuilt supergraph (single model)

The supergraph SDL is always composed **before** Router boots — never at startup.
Router reads a static `supergraph.graphql` file. This avoids flaky startup issues
where `depends_on` doesn't guarantee subgraph readiness.

### Local development

```bash
# 1. Edit schema in service repo
# 2. Validate subgraph in isolation
rover subgraph check --schema <path-to-schema>

# 3. Compose supergraph from SDL files (not live introspection)
#    This reads schema files directly from disk — no running services needed.
rover supergraph compose --config services/apollo-router/supergraph-config.yaml \
  --output services/apollo-router/supergraph.graphql

# 4. docker-compose up — Router loads the prebuilt supergraph.graphql
# 5. Test at http://localhost:8000/graphql (through Kong)
#    Sandbox at http://localhost:4001 (direct to Router)
```

**`supergraph-config.yaml` uses file paths for local composition (not URLs):**
```yaml
federation_version: =2.9
subgraphs:
  auth:
    routing_url: http://auth-service:3000/graphql
    schema:
      file: ../../services/auth-service/src/graphql/schema.graphql
  tickets:
    routing_url: http://ticket-service:3001/graphql
    schema:
      file: ../../services/ticket-service/internal/graphql/schema.graphqls
  # ... same pattern for each subgraph
```

The `routing_url` tells Router where to send queries at runtime. The `schema.file`
tells `rover` where to read the SDL at compose time. This separation means
composition works without running services.

### CI (GitHub Actions)

```yaml
on:
  pull_request:
    paths:
      - 'services/*/src/graphql/**'
      - 'services/*/internal/graphql/**'
      - 'services/*/src/main/resources/schema/**'

jobs:
  schema-check:
    steps:
      - name: Install Rover
        run: curl -sSL https://rover.apollo.dev/nix/latest | sh
      - name: Compose supergraph
        run: rover supergraph compose --config services/apollo-router/supergraph-config.yaml
```

Composition failure blocks the PR. No external schema registry required.

---

## Error Handling

- **Partial responses** — if one subgraph fails, Router returns data from successful subgraphs + errors from the failed one.
- **Subgraph timeouts** — Router enforces per-subgraph timeouts (5s default). Aligns with existing gRPC deadline pattern.
- **No secret leakage** — resolvers map internal errors to sanitized GraphQL errors with `extensions.code`.
- **Error format:**

```json
{
  "errors": [{
    "message": "Ticket not found",
    "path": ["order", "ticket"],
    "extensions": { "code": "NOT_FOUND", "service": "ticket-service" }
  }],
  "data": { "order": { "id": "123", "ticket": null } }
}
```

---

## Observability

### Tracing

- Router exports OTEL spans to existing collector (port 4317).
- `traceparent`/`tracestate` propagated: Client → Kong → Router → Subgraph.
- GraphQL operation name in span attributes.

### Metrics

- Router built-in Prometheus metrics: `apollo_router_http_requests_total`, `apollo_router_http_request_duration_seconds`.
- Per-subgraph latency breakdown.
- Scrape config same as existing services.

### Logging

- Router: structured JSON logs, same format as existing services.
- Operation-level: query name, subgraph calls, duration per subgraph.

### N+1 mitigation and batching

The primary GraphQL performance concern is N+1 queries during entity resolution.
When Router resolves `User.orders → [Order] → Order.ticket`, a naive implementation
makes one subgraph call per entity. Federation mitigates this via **entity batching**.

**How Apollo Router batches:**
Router collects all `@key` references for a subgraph and sends them in a single
`_entities(representations: [...])` batch query. For example, if 10 orders reference
10 different tickets, Router sends ONE request to ticket-service with all 10 keys.

**Per-subgraph DataLoader requirements:**

| Subgraph | Pattern | Why |
|---|---|---|
| order-service (Spring GraphQL) | `@BatchMapping` or `DataLoader` bean | `User.orders` resolves N users' orders — batch `findByUserIds(List<UUID>)` |
| ticket-service (gqlgen) | `dataloadgen` package | Entity resolver receives batch of ticket IDs — batch `findByIds([]string)` |
| venue-service (gqlgen) | `dataloadgen` package | `Ticket.seatingPlan` resolves N plans — batch `findByIds([]string)` |
| payment-service (NestJS) | `@nestjs/dataloader` or `dataloader` npm | `Order.payment` resolves N payments — batch `findByOrderIds(string[])` |
| auth-service (NestJS) | `dataloader` npm | Entity resolver batch `findByIds(string[])` |
| user-service (NestJS) | `dataloader` npm | Entity resolver batch `findByIds(string[])` |

**Implementation example (Spring GraphQL):**
```java
@SchemaMapping(typeName = "User", field = "orders")
public List<OrderResponse> userOrders(
        @Argument Map<String, Object> user,
        GraphQLContext ctx) {
    String userId = (String) user.get("id");
    String requesterId = ctx.get(UserIdInterceptor.USER_ID_KEY);
    if (!userId.equals(requesterId)) return List.of();
    return orderService.listOrders(UUID.fromString(userId));
}
```

**Implementation example (gqlgen):**
Entity resolvers in gqlgen receive `[]map[string]any` (batch of representations)
by default when federation batching is enabled. Implement the batch lookup in the
entity resolver.

**Key rule:** Every entity resolver and every list-returning field resolver MUST use
a DataLoader/batch pattern. No single-record lookups in resolvers.

### Rate limiting & query protection

- Rate limiting by Kong on `/graphql` (60/min, tunable).
- Query depth limit: 15 (in `router.yaml`).
- Query height limit: 200.

---

## Rollout Order

### Step 1 — Infrastructure scaffolding

- Add Apollo Router service (config, Dockerfile, docker-compose entry)
- Add Kong `/graphql` route
- Install `rover` CLI in CI

### Step 2 — Simplest subgraphs (prove the pipeline)

- `auth-service` — smallest schema, User entity with `currentUser` query only (auth mutations stay REST-only)
- `user-service` — extends User with profile data

**Validates:** composition, Kong→Router→Subgraph chain, auth passthrough, OTEL tracing.

### Step 3 — Core domain subgraphs

- `ticket-service` (Go/gqlgen) — first Go subgraph, Ticket entity
- `payment-service` (NestJS) — Payment entity

**Validates:** polyglot federation (TS + Go), entity resolution across subgraphs.

### Step 4 — Complex subgraphs

- `venue-service` (Go/gqlgen) — SeatingPlan, references Ticket
- `order-service` (Java/Spring GraphQL) — references Ticket + Payment + User, primary Java subgraph

**Validates:** multi-hop entity resolution, Spring GraphQL federation, cross-service queries spanning 4+ subgraphs.

### Step 5 — Frontend integration

- Add GraphQL client to Next.js app (`urql` or `@apollo/client`)
- Migrate one page (e.g., order details) from REST to GraphQL
- Compare developer experience

---

## Docker Compose Addition

```yaml
apollo-router:
  image: ghcr.io/apollographql/router:v2.x
  volumes:
    - ./services/apollo-router/router.yaml:/dist/config/router.yaml
    - ./services/apollo-router/supergraph.graphql:/dist/config/supergraph.graphql
  environment:
    - APOLLO_SANDBOX_ENABLED=true   # local dev only; false in staging/prod
  ports:
    - "4001:4001"
  networks:
    - microservices-net
  healthcheck:
    test: ["CMD", "bash", "-lc", "exec 3<>/dev/tcp/127.0.0.1/8088 && printf 'GET /health HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n' >&3 && head -n 1 <&3 | grep -q '200 OK'"]
    interval: 10s
    timeout: 5s
    retries: 3
```

Router boots with the prebuilt `supergraph.graphql` and does not depend on subgraph
services being ready at startup. If a subgraph is down at query time, Router returns
a partial response with errors for the unreachable subgraph — this is standard
federation behavior and is safe.

---

## Out of Scope

- **GraphQL subscriptions** — can be added later via WebSocket support in Router + Kong. Not needed for initial rollout.
- **Persisted queries** — optimization for production. Not needed for learning phase.
- **Apollo GraphOS (paid)** — self-managed composition via `rover` CLI is sufficient.
- **Expiration-service subgraph** — no API surface, excluded.
- **REST endpoint removal** — REST stays permanently. GraphQL is additive.
