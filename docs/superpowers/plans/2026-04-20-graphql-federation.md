# GraphQL Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Apollo Federation v2 GraphQL layer alongside existing REST/gRPC APIs, with each service owning its own subgraph schema and Apollo Router composing them into a unified supergraph behind Kong.

**Architecture:** Apollo Router (Rust binary) sits behind Kong on internal port 4001. Kong routes `/graphql` to it with JWT auth + CORS. Six services (auth, user, payment, ticket, venue, order) each expose a `/graphql` endpoint using their native framework's GraphQL library. `rover supergraph compose` builds the supergraph from on-disk SDL files before Router boots.

**Tech Stack:** Apollo Router v2.x, Apollo Federation v2.9, `@nestjs/graphql` + `@apollo/subgraph` (NestJS services), `gqlgen` with federation plugin (Go services), Spring GraphQL (Java/Spring Boot), `rover` CLI for composition.

> **Note:** order-service uses Spring GraphQL (`@Controller` + `@QueryMapping`/`@SchemaMapping`) instead of Netflix DGS as originally planned. Deviation is documented in the spec.

**Spec:** `docs/superpowers/specs/2026-04-20-graphql-federation-design.md`

---

## File Map

### New files

| File | Purpose |
|---|---|
| `services/apollo-router/Dockerfile` | Router container image |
| `services/apollo-router/router.yaml` | Router runtime config (headers, telemetry, limits) |
| `services/apollo-router/supergraph-config.yaml` | Subgraph registry for `rover supergraph compose` |
| `services/apollo-router/supergraph.graphql` | Composed supergraph SDL (generated, gitignored) |
| `services/apollo-router/scripts/compose.sh` | Wrapper script for `rover supergraph compose` |
| `services/auth-service/src/graphql/schema.graphql` | Auth subgraph SDL |
| `services/auth-service/src/graphql/graphql.module.ts` | NestJS GraphQL module config |
| `services/auth-service/src/graphql/auth.resolver.ts` | Auth resolvers |
| `services/auth-service/src/graphql/auth.resolver.spec.ts` | Resolver tests |
| `services/user-service/src/graphql/schema.graphql` | User subgraph SDL |
| `services/user-service/src/graphql/graphql.module.ts` | NestJS GraphQL module config |
| `services/user-service/src/graphql/user.resolver.ts` | User resolvers |
| `services/user-service/src/graphql/user.resolver.spec.ts` | Resolver tests |
| `services/payment-service/src/graphql/schema.graphql` | Payment subgraph SDL |
| `services/payment-service/src/graphql/graphql.module.ts` | NestJS GraphQL module config |
| `services/payment-service/src/graphql/payment.resolver.ts` | Payment resolvers |
| `services/payment-service/src/graphql/payment.resolver.spec.ts` | Resolver tests |
| `services/ticket-service/internal/graphql/schema.graphqls` | Ticket subgraph SDL |
| `services/ticket-service/internal/graphql/resolver.go` | Ticket resolvers |
| `services/ticket-service/internal/graphql/model.go` | Custom model mappings |
| `services/ticket-service/internal/graphql/generated.go` | gqlgen generated code |
| `services/ticket-service/internal/graphql/resolver_test.go` | Resolver tests |
| `services/ticket-service/gqlgen.yml` | gqlgen config |
| `services/venue-service/internal/graphql/schema.graphqls` | Venue subgraph SDL |
| `services/venue-service/internal/graphql/resolver.go` | Venue resolvers |
| `services/venue-service/internal/graphql/model.go` | Custom model mappings |
| `services/venue-service/internal/graphql/generated.go` | gqlgen generated code |
| `services/venue-service/internal/graphql/resolver_test.go` | Resolver tests |
| `services/venue-service/gqlgen.yml` | gqlgen config |
| `services/order-service/src/main/java/com/ticketing/orders/graphql/OrderGraphqlController.java` | Spring GraphQL query/mutation controller |
| `services/order-service/src/main/java/com/ticketing/orders/graphql/FederationConfig.java` | Spring GraphQL federation entity resolution |
| `services/order-service/src/main/java/com/ticketing/orders/graphql/UserIdInterceptor.java` | WebGraphQL interceptor for X-User-Id |
| `services/order-service/src/main/java/com/ticketing/orders/graphql/OrdersDataLoader.java` | Batch loader |
| `services/order-service/src/main/resources/schema/schema.graphqls` | Order subgraph SDL |
| `services/order-service/src/test/java/com/ticketing/orders/graphql/OrderGraphqlControllerTest.java` | Spring GraphQL controller tests |
| `.github/workflows/graphql-schema-check.yml` | CI schema composition check |

### Modified files

| File | Change |
|---|---|
| `services/kong-gateway/config/kong.base.yml` | Add apollo-router service + `/graphql` route before client-service |
| `services/kong-gateway/values/_defaults.yml` | Add `HOST_APOLLO_ROUTER` and `GRAPHQL_READ_TIMEOUT_MS` |
| `services/kong-gateway/values/local.yml` | Add `HOST_APOLLO_ROUTER` |
| `docker-compose.yml` | Add apollo-router service |
| `services/auth-service/src/app.module.ts` | Import GraphQL module |
| `services/auth-service/package.json` | Add GraphQL dependencies |
| `services/user-service/src/app.module.ts` | Import GraphQL module |
| `services/user-service/package.json` | Add GraphQL dependencies |
| `services/payment-service/src/app.module.ts` | Import GraphQL module |
| `services/payment-service/package.json` | Add GraphQL dependencies |
| `services/ticket-service/cmd/server/main.go` | Mount `/graphql` route on Echo |
| `services/ticket-service/go.mod` | Add gqlgen dependency |
| `services/venue-service/cmd/server/main.go` | Mount `/graphql` route on Echo |
| `services/venue-service/go.mod` | Add gqlgen dependency |
| `services/order-service/pom.xml` | Add Spring GraphQL + federation-jvm dependency |
| `docs/03-api-design.md` | Add GraphQL as approved protocol |

---

## Task 1: Apollo Router service scaffolding

**Files:**
- Create: `services/apollo-router/Dockerfile`
- Create: `services/apollo-router/router.yaml`
- Create: `services/apollo-router/scripts/compose.sh`
- Create: `services/apollo-router/.gitignore`

- [ ] **Step 1: Create the Router directory and Dockerfile**

```bash
mkdir -p services/apollo-router/scripts
```

Create `services/apollo-router/Dockerfile`:

```dockerfile
FROM ghcr.io/apollographql/router:v2.1.1

COPY router.yaml /dist/config/router.yaml
COPY supergraph.graphql /dist/config/supergraph.graphql

EXPOSE 4001

CMD ["--config", "/dist/config/router.yaml", "--supergraph", "/dist/config/supergraph.graphql"]
```

- [ ] **Step 2: Create router.yaml**

Create `services/apollo-router/router.yaml`:

```yaml
supergraph:
  path: /dist/config/supergraph.graphql

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

- [ ] **Step 3: Create compose.sh wrapper**

Create `services/apollo-router/scripts/compose.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTER_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$ROUTER_DIR/../.." && pwd)"

ROVER_BIN="${ROVER_BIN:-rover}"

echo "Composing supergraph from subgraph SDL files..."
"$ROVER_BIN" supergraph compose \
  --config "$ROUTER_DIR/supergraph-config.yaml" \
  --output "$ROUTER_DIR/supergraph.graphql"

echo "Supergraph composed: $ROUTER_DIR/supergraph.graphql"
```

```bash
chmod +x services/apollo-router/scripts/compose.sh
```

- [ ] **Step 4: Create .gitignore for generated supergraph**

Create `services/apollo-router/.gitignore`:

```
supergraph.graphql
```

- [ ] **Step 5: Commit**

```bash
git add services/apollo-router/
git commit -m "feat(graphql): scaffold Apollo Router service

Add Dockerfile, router.yaml (header propagation, OTEL, limits),
compose script, and gitignore for generated supergraph.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Kong gateway integration

**Files:**
- Modify: `services/kong-gateway/config/kong.base.yml` (insert before line 752, the client-service entry)
- Modify: `services/kong-gateway/values/_defaults.yml`
- Modify: `services/kong-gateway/values/local.yml`

- [ ] **Step 1: Add HOST_APOLLO_ROUTER to Kong values**

In `services/kong-gateway/values/_defaults.yml`, after the line `HOST_VENUE: venue-service:3003`, add:

```yaml
HOST_APOLLO_ROUTER: apollo-router:4001
```

In `services/kong-gateway/values/_defaults.yml`, after the line `CLIENT_WRITE_TIMEOUT_MS: 30000`, add:

```yaml
GRAPHQL_READ_TIMEOUT_MS: 30000
```

In `services/kong-gateway/values/local.yml`, after the line `HOST_VENUE: venue-service:3003`, add:

```yaml
HOST_APOLLO_ROUTER: apollo-router:4001
```

- [ ] **Step 2: Add apollo-router service entry in kong.base.yml**

Insert the following **before** the `client-service` entry (before line 752). This must come before the client catch-all route or `/graphql` will be swallowed by the `/ ` path.

```yaml
  # ── apollo-router (GraphQL Federation gateway) ───────────────────────────────
  - name: apollo-router
    url: http://{{HOST_APOLLO_ROUTER}}
    connect_timeout: {{CONNECT_TIMEOUT_MS}}
    read_timeout: {{GRAPHQL_READ_TIMEOUT_MS}}
    write_timeout: {{CONNECT_TIMEOUT_MS}}
    routes:
      - name: graphql
        paths:
          - /graphql
        methods: [POST, OPTIONS]
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
              minute: {{RATE_LIMIT_AUTHENTICATED_PER_MINUTE}}
              policy: {{RATE_LIMIT_POLICY}}
```

- [ ] **Step 3: Verify Kong config renders**

Run:

```bash
cd services/kong-gateway && KONG_RSA_PUBLIC_KEY="test" KONG_SIGNING_KEY="test" ./scripts/build.sh local
```

Expected: exits 0, `kong.yml` is generated with the `apollo-router` service and `/graphql` route visible. Verify no unresolved placeholders.

- [ ] **Step 4: Commit**

```bash
git add services/kong-gateway/
git commit -m "feat(kong): add /graphql route proxying to Apollo Router

JWT auth + post-function identity injection + CORS for browser-hosted
GraphQL IDEs. Route placed before client catch-all.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Docker Compose integration

**Files:**
- Modify: `docker-compose.yml` (add apollo-router before expiration-service)

- [ ] **Step 1: Add apollo-router service to docker-compose.yml**

Insert the following **before** the `expiration-service` entry:

```yaml
  apollo-router:
    image: ghcr.io/apollographql/router:v2.1.1
    restart: unless-stopped
    volumes:
      - ./services/apollo-router/router.yaml:/dist/config/router.yaml
      - ./services/apollo-router/supergraph.graphql:/dist/config/supergraph.graphql
    environment:
      APOLLO_SANDBOX_ENABLED: "true"
    ports:
      - "4001:4001"
    mem_limit: 256m
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4001/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - microservices-net
```

Note: no `depends_on` — Router boots with a prebuilt supergraph.graphql and handles subgraph unavailability gracefully via partial responses.

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): add Apollo Router to docker-compose

Mounts prebuilt supergraph.graphql, exposes Sandbox on :4001
for local dev.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Update API design standard

**Files:**
- Modify: `docs/03-api-design.md` (line 6)

- [ ] **Step 1: Add GraphQL as approved protocol**

In `docs/03-api-design.md`, after the line:

```
- Use **REST + JSON** for public/client-facing APIs.
```

Add:

```
- **GraphQL** (via Apollo Federation v2) is an approved alternative for flexible client queries. See `docs/superpowers/specs/2026-04-20-graphql-federation-design.md` for architecture details. REST remains the default for new endpoints.
```

- [ ] **Step 2: Commit**

```bash
git add docs/03-api-design.md
git commit -m "docs(api): add GraphQL as approved protocol alongside REST

Apollo Federation v2 approved for flexible client queries.
REST remains the default for new endpoints.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: CI schema composition check

**Files:**
- Create: `.github/workflows/graphql-schema-check.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/graphql-schema-check.yml`:

```yaml
name: GraphQL Schema Check

on:
  pull_request:
    paths:
      - "services/*/src/graphql/**"
      - "services/*/internal/graphql/**"
      - "services/*/src/main/resources/schema/**"
      - "services/apollo-router/supergraph-config.yaml"

jobs:
  compose:
    name: Compose supergraph
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Rover CLI
        run: |
          curl -sSL https://rover.apollo.dev/nix/latest | sh
          echo "$HOME/.rover/bin" >> "$GITHUB_PATH"

      - name: Compose supergraph
        run: |
          rover supergraph compose \
            --config services/apollo-router/supergraph-config.yaml \
            --output /tmp/supergraph.graphql
          echo "Supergraph composed successfully"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/graphql-schema-check.yml
git commit -m "ci: add GraphQL schema composition check on PR

Blocks PRs if subgraph schemas are incompatible.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 6: auth-service subgraph — schema and dependencies

**Files:**
- Create: `services/auth-service/src/graphql/schema.graphql`
- Modify: `services/auth-service/package.json`

- [ ] **Step 1: Create the auth subgraph SDL**

Create `services/auth-service/src/graphql/schema.graphql`:

```graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.9", import: ["@key", "@tag"])

type User @key(fields: "id") {
  id: ID!
  email: String @tag(name: "self-only")
}

type Query {
  currentUser: User
}
```

- [ ] **Step 2: Install GraphQL dependencies**

Run:

```bash
cd services/auth-service && pnpm add @nestjs/graphql @nestjs/apollo @apollo/subgraph graphql @apollo/server
```

- [ ] **Step 3: Commit**

```bash
git add services/auth-service/src/graphql/schema.graphql services/auth-service/package.json services/auth-service/pnpm-lock.yaml
git commit -m "feat(auth): add federation subgraph schema and dependencies

User entity with self-only email field. No mutations — auth
operations stay REST-only.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 7: auth-service subgraph — resolver with tests

**Files:**
- Create: `services/auth-service/src/graphql/auth.resolver.spec.ts`
- Create: `services/auth-service/src/graphql/auth.resolver.ts`
- Create: `services/auth-service/src/graphql/graphql.module.ts`
- Modify: `services/auth-service/src/app.module.ts`

- [ ] **Step 1: Write the failing resolver test**

Create `services/auth-service/src/graphql/auth.resolver.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthResolver } from './auth.resolver';

describe('AuthResolver', () => {
  let resolver: AuthResolver;
  const mockUsersRepository = {
    findById: vi.fn(),
  };

  beforeEach(() => {
    resolver = new AuthResolver(mockUsersRepository as any);
    vi.clearAllMocks();
  });

  describe('currentUser', () => {
    it('returns the user when X-User-Id header is present', async () => {
      const user = { id: 'user-123', email: 'test@test.com' };
      mockUsersRepository.findById.mockResolvedValue(user);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.currentUser(ctx);

      expect(result).toEqual({ id: 'user-123', email: 'test@test.com' });
      expect(mockUsersRepository.findById).toHaveBeenCalledWith('user-123');
    });

    it('returns null when X-User-Id header is missing', async () => {
      const ctx = { req: { headers: {} } };
      const result = await resolver.currentUser(ctx);

      expect(result).toBeNull();
      expect(mockUsersRepository.findById).not.toHaveBeenCalled();
    });
  });

  describe('resolveReference', () => {
    it('resolves a User entity by id', async () => {
      const user = { id: 'user-456', email: 'other@test.com' };
      mockUsersRepository.findById.mockResolvedValue(user);

      const result = await resolver.resolveReference({ __typename: 'User', id: 'user-456' });

      expect(result).toEqual({ id: 'user-456', email: 'other@test.com' });
    });
  });

  describe('email field', () => {
    it('returns email when requester is the user', () => {
      const user = { id: 'user-123', email: 'self@test.com' };
      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };

      const result = resolver.email(user, ctx);
      expect(result).toBe('self@test.com');
    });

    it('returns null when requester is a different user', () => {
      const user = { id: 'user-123', email: 'self@test.com' };
      const ctx = { req: { headers: { 'x-user-id': 'other-user' } } };

      const result = resolver.email(user, ctx);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd services/auth-service && pnpm test -- --run src/graphql/auth.resolver.spec.ts
```

Expected: FAIL — `Cannot find module './auth.resolver'`

- [ ] **Step 3: Implement the resolver**

Create `services/auth-service/src/graphql/auth.resolver.ts`:

```typescript
import { Resolver, Query, ResolveField, Parent, Context, ResolveReference } from '@nestjs/graphql';
import { UsersRepository } from '../modules/users/users.repository';

@Resolver('User')
export class AuthResolver {
  constructor(private readonly usersRepository: UsersRepository) {}

  @Query()
  async currentUser(@Context() ctx: any) {
    const userId = ctx.req.headers['x-user-id'];
    if (!userId) return null;
    return this.usersRepository.findById(userId);
  }

  @ResolveReference()
  async resolveReference(reference: { __typename: string; id: string }) {
    return this.usersRepository.findById(reference.id);
  }

  @ResolveField()
  email(@Parent() user: any, @Context() ctx: any) {
    const requesterId = ctx.req.headers['x-user-id'];
    if (requesterId !== user.id) return null;
    return user.email;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd services/auth-service && pnpm test -- --run src/graphql/auth.resolver.spec.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Create the GraphQL module**

Create `services/auth-service/src/graphql/graphql.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { AuthResolver } from './auth.resolver';
import { UsersModule } from '../modules/users/users.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + '/schema.graphql'],
      playground: false,
    }),
    UsersModule,
  ],
  providers: [AuthResolver],
})
export class AuthGraphQLModule {}
```

- [ ] **Step 6: Register the GraphQL module in app.module.ts**

In `services/auth-service/src/app.module.ts`, add the import:

```typescript
import { AuthGraphQLModule } from './graphql/graphql.module';
```

And add `AuthGraphQLModule` to the `imports` array.

- [ ] **Step 7: Verify the service starts**

Run:

```bash
cd services/auth-service && pnpm build
```

Expected: compiles without errors.

- [ ] **Step 8: Commit**

```bash
git add services/auth-service/src/graphql/ services/auth-service/src/app.module.ts
git commit -m "feat(auth): implement federation subgraph resolver

currentUser query, entity resolution, self-only email field.
Resolver delegates to existing UsersRepository.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 8: user-service subgraph — schema and dependencies

**Files:**
- Create: `services/user-service/src/graphql/schema.graphql`
- Modify: `services/user-service/package.json`

- [ ] **Step 1: Create the user subgraph SDL**

Create `services/user-service/src/graphql/schema.graphql`:

```graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.9", import: ["@key", "@tag", "@external"])

type User @key(fields: "id") {
  id: ID!
  profile: UserProfile @tag(name: "self-only")
  preferences: UserPreferences @tag(name: "self-only")
}

type UserProfile {
  displayName: String
  locale: String
  timezone: String
  billingAddress: BillingAddress @tag(name: "pii")
}

type BillingAddress {
  line1: String
  line2: String
  city: String
  state: String
  postalCode: String
  country: String
}

type UserPreferences {
  marketingOptIn: Boolean
  orderUpdates: Boolean
  productUpdates: Boolean
}
```

- [ ] **Step 2: Install GraphQL dependencies**

Run:

```bash
cd services/user-service && pnpm add @nestjs/graphql @nestjs/apollo @apollo/subgraph graphql @apollo/server
```

- [ ] **Step 3: Commit**

```bash
git add services/user-service/src/graphql/schema.graphql services/user-service/package.json services/user-service/pnpm-lock.yaml
git commit -m "feat(user): add federation subgraph schema and dependencies

Extends User entity with profile, preferences, billing address.
Self-only and PII fields tagged.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 9: user-service subgraph — resolver with tests

**Files:**
- Create: `services/user-service/src/graphql/user.resolver.spec.ts`
- Create: `services/user-service/src/graphql/user.resolver.ts`
- Create: `services/user-service/src/graphql/graphql.module.ts`
- Modify: `services/user-service/src/app.module.ts`

- [ ] **Step 1: Write the failing resolver test**

Create `services/user-service/src/graphql/user.resolver.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserResolver } from './user.resolver';

describe('UserResolver', () => {
  let resolver: UserResolver;
  const mockUserSettingsService = {
    getProfile: vi.fn(),
    getPreferences: vi.fn(),
    getBillingAddress: vi.fn(),
  };

  beforeEach(() => {
    resolver = new UserResolver(mockUserSettingsService as any);
    vi.clearAllMocks();
  });

  describe('resolveReference', () => {
    it('returns user stub with id for federation', async () => {
      const result = await resolver.resolveReference({ __typename: 'User', id: 'user-123' });
      expect(result).toEqual({ id: 'user-123' });
    });
  });

  describe('profile', () => {
    it('returns profile when requester is self', async () => {
      const profile = { displayName: 'Jane', locale: 'en-US', timezone: 'UTC' };
      mockUserSettingsService.getProfile.mockResolvedValue(profile);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.profile({ id: 'user-123' }, ctx);

      expect(result).toEqual(profile);
    });

    it('returns null when requester is not self', async () => {
      const ctx = { req: { headers: { 'x-user-id': 'other-user' } } };
      const result = await resolver.profile({ id: 'user-123' }, ctx);

      expect(result).toBeNull();
      expect(mockUserSettingsService.getProfile).not.toHaveBeenCalled();
    });
  });

  describe('preferences', () => {
    it('returns preferences when requester is self', async () => {
      const prefs = { marketingOptIn: true, orderUpdates: true, productUpdates: false };
      mockUserSettingsService.getPreferences.mockResolvedValue(prefs);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.preferences({ id: 'user-123' }, ctx);

      expect(result).toEqual(prefs);
    });

    it('returns null when requester is not self', async () => {
      const ctx = { req: { headers: { 'x-user-id': 'other-user' } } };
      const result = await resolver.preferences({ id: 'user-123' }, ctx);

      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd services/user-service && pnpm test -- --run src/graphql/user.resolver.spec.ts
```

Expected: FAIL — `Cannot find module './user.resolver'`

- [ ] **Step 3: Implement the resolver**

Create `services/user-service/src/graphql/user.resolver.ts`:

```typescript
import { Resolver, ResolveField, Parent, Context, ResolveReference } from '@nestjs/graphql';
import { UserSettingsService } from '../modules/user-settings/user-settings.service';

@Resolver('User')
export class UserResolver {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @ResolveReference()
  async resolveReference(reference: { __typename: string; id: string }) {
    return { id: reference.id };
  }

  @ResolveField()
  async profile(@Parent() user: any, @Context() ctx: any) {
    if (ctx.req.headers['x-user-id'] !== user.id) return null;
    return this.userSettingsService.getProfile(user.id);
  }

  @ResolveField()
  async preferences(@Parent() user: any, @Context() ctx: any) {
    if (ctx.req.headers['x-user-id'] !== user.id) return null;
    return this.userSettingsService.getPreferences(user.id);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd services/user-service && pnpm test -- --run src/graphql/user.resolver.spec.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Create the GraphQL module and wire into app**

Create `services/user-service/src/graphql/graphql.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { UserResolver } from './user.resolver';
import { UserSettingsModule } from '../modules/user-settings/user-settings.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + '/schema.graphql'],
      playground: false,
    }),
    UserSettingsModule,
  ],
  providers: [UserResolver],
})
export class UserGraphQLModule {}
```

In `services/user-service/src/app.module.ts`, add:

```typescript
import { UserGraphQLModule } from './graphql/graphql.module';
```

Add `UserGraphQLModule` to the `imports` array.

- [ ] **Step 6: Verify the service builds**

Run:

```bash
cd services/user-service && pnpm build
```

Expected: compiles without errors.

- [ ] **Step 7: Commit**

```bash
git add services/user-service/src/graphql/ services/user-service/src/app.module.ts
git commit -m "feat(user): implement federation subgraph resolver

Entity resolution, self-only profile and preferences fields.
Delegates to existing UserSettingsService.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 10: First supergraph composition and end-to-end test

**Files:**
- Create: `services/apollo-router/supergraph-config.yaml`

- [ ] **Step 1: Create supergraph-config.yaml with auth + user subgraphs**

Create `services/apollo-router/supergraph-config.yaml`:

```yaml
federation_version: =2.9
subgraphs:
  auth:
    routing_url: http://auth-service:3000/graphql
    schema:
      file: ../auth-service/src/graphql/schema.graphql
  users:
    routing_url: http://user-service:3004/graphql
    schema:
      file: ../user-service/src/graphql/schema.graphql
```

- [ ] **Step 2: Install rover CLI and compose the supergraph**

Run:

```bash
curl -sSL https://rover.apollo.dev/nix/latest | sh
```

Then:

```bash
cd services/apollo-router && ~/.rover/bin/rover supergraph compose \
  --config supergraph-config.yaml \
  --output supergraph.graphql
```

Expected: exits 0, creates `supergraph.graphql` with both subgraph schemas merged.

- [ ] **Step 3: Start the stack and test end-to-end**

```bash
docker-compose up -d auth-service user-service apollo-router kong-gateway
```

Wait for health checks to pass, then test through Kong:

```bash
# Test introspection (requires a valid JWT — obtain one via REST signup/signin first)
curl -X POST http://localhost:8000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JWT>" \
  -d '{"query": "{ currentUser { id email } }"}'
```

Expected: returns `{ "data": { "currentUser": { "id": "...", "email": "..." } } }` if authenticated, or errors if JWT is invalid.

Also test Apollo Sandbox directly:

```bash
open http://localhost:4001
```

Expected: Apollo Sandbox UI loads.

- [ ] **Step 4: Commit**

```bash
git add services/apollo-router/supergraph-config.yaml
git commit -m "feat(graphql): first supergraph composition with auth + user

Validates end-to-end: Kong → Router → subgraph chain,
identity header propagation, entity resolution.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 11: ticket-service subgraph — gqlgen setup and schema

**Files:**
- Create: `services/ticket-service/gqlgen.yml`
- Create: `services/ticket-service/internal/graphql/schema.graphqls`
- Modify: `services/ticket-service/go.mod`

- [ ] **Step 1: Add gqlgen dependency**

Run:

```bash
cd services/ticket-service && go get github.com/99designs/gqlgen@latest
```

- [ ] **Step 2: Create gqlgen.yml**

Create `services/ticket-service/gqlgen.yml`:

```yaml
schema:
  - internal/graphql/schema.graphqls

exec:
  filename: internal/graphql/generated.go
  package: graphql

model:
  filename: internal/graphql/model.go
  package: graphql

resolver:
  layout: follow-schema
  dir: internal/graphql
  package: graphql
  filename_template: "{name}.resolvers.go"

federation:
  filename: internal/graphql/federation.go
  package: graphql
  version: 2
```

- [ ] **Step 3: Create the ticket subgraph SDL**

Create `services/ticket-service/internal/graphql/schema.graphqls`:

```graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.9", import: ["@key", "@provides", "@tag"])

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

type SeatingPlan @key(fields: "id", resolvable: false) {
  id: ID!
}

enum TicketType {
  GENERAL_ADMISSION
  SEATED
}

scalar DateTime

type Query {
  tickets: [Ticket!]!
  ticket(id: ID!): Ticket
}

type Mutation {
  createTicket(input: CreateTicketInput!): Ticket!
  updateTicket(id: ID!, input: UpdateTicketInput!): Ticket!
}

input CreateTicketInput {
  title: String!
  price: Int!
  quota: Int!
  maxPerUser: Int
  ticketType: TicketType!
}

input UpdateTicketInput {
  title: String
  price: Int
  quota: Int
  maxPerUser: Int
}
```

- [ ] **Step 4: Generate gqlgen code**

Run:

```bash
cd services/ticket-service && go run github.com/99designs/gqlgen generate
```

Expected: creates `internal/graphql/generated.go`, `internal/graphql/model.go`, `internal/graphql/federation.go`, and resolver stub files.

- [ ] **Step 5: Commit**

```bash
git add services/ticket-service/gqlgen.yml services/ticket-service/internal/graphql/ services/ticket-service/go.mod services/ticket-service/go.sum
git commit -m "feat(ticket): scaffold gqlgen federation subgraph

Schema with Ticket entity, SeatingPlan reference, and
generated resolver stubs.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 12: ticket-service subgraph — resolvers with tests

**Files:**
- Modify: `services/ticket-service/internal/graphql/resolver.go` (or generated resolver file)
- Create: `services/ticket-service/internal/graphql/resolver_test.go`
- Modify: `services/ticket-service/cmd/server/main.go`

- [ ] **Step 1: Write the failing resolver test**

Create `services/ticket-service/internal/graphql/resolver_test.go`:

```go
package graphql_test

import (
	"context"
	"testing"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/99designs/gqlgen/graphql/handler"
	graphqlpkg "<MODULE_PATH>/internal/graphql"
	"<MODULE_PATH>/internal/repository"
)

type mockTicketService struct {
	getByIDFn func(ctx context.Context, id string) (*repository.Ticket, error)
	listFn    func(ctx context.Context) ([]repository.Ticket, error)
}

func (m *mockTicketService) GetTicketByID(ctx context.Context, id string) (*repository.Ticket, error) {
	return m.getByIDFn(ctx, id)
}

func (m *mockTicketService) ListTickets(ctx context.Context) ([]repository.Ticket, error) {
	return m.listFn(ctx)
}

func TestTicketQuery(t *testing.T) {
	svc := &mockTicketService{
		getByIDFn: func(_ context.Context, id string) (*repository.Ticket, error) {
			return &repository.Ticket{ID: id, Title: "Concert", Price: "5000"}, nil
		},
	}

	resolver := &graphqlpkg.Resolver{TicketService: svc}
	srv := handler.NewDefaultServer(graphqlpkg.NewExecutableSchema(graphqlpkg.Config{Resolvers: resolver}))

	body := `{"query": "{ ticket(id: \"t1\") { id title price } }"}`
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	srv.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"title":"Concert"`) {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}
```

Note: Replace `<MODULE_PATH>` with the actual Go module path from `go.mod` (likely `github.com/emmilcheung/microservices/services/ticket-service` or similar).

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd services/ticket-service && go test ./internal/graphql/ -run TestTicketQuery -v
```

Expected: FAIL — resolver methods not implemented yet.

- [ ] **Step 3: Implement the resolvers**

Edit the generated resolver file (likely `services/ticket-service/internal/graphql/schema.resolvers.go`) to implement the query and mutation resolvers:

```go
package graphql

import (
	"context"
	"strconv"

	"<MODULE_PATH>/internal/service"
)

type Resolver struct {
	TicketService *service.TicketService
}

func (r *queryResolver) Tickets(ctx context.Context) ([]*Ticket, error) {
	tickets, err := r.TicketService.ListTickets(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]*Ticket, len(tickets))
	for i, t := range tickets {
		result[i] = mapTicketToGraphQL(&t)
	}
	return result, nil
}

func (r *queryResolver) Ticket(ctx context.Context, id string) (*Ticket, error) {
	t, err := r.TicketService.GetTicketByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil
	}
	return mapTicketToGraphQL(t), nil
}

func mapTicketToGraphQL(t *repository.Ticket) *Ticket {
	price, _ := strconv.Atoi(t.Price)
	available := t.Quota - t.Reserved - t.Sold
	result := &Ticket{
		ID:         t.ID,
		Title:      t.Title,
		Price:      price,
		Quota:      t.Quota,
		Available:  available,
		MaxPerUser: &t.MaxPerUser,
		TicketType: TicketType(t.TicketType),
		CreatedAt:  t.CreatedAt,
		UpdatedAt:  t.UpdatedAt,
	}
	if t.SeatingPlanID != "" {
		result.SeatingPlan = &SeatingPlan{ID: t.SeatingPlanID}
	}
	return result
}
```

Also implement the entity resolver for federation in `federation.go` or the generated entity resolver file:

```go
func (r *entityResolver) FindTicketByID(ctx context.Context, id string) (*Ticket, error) {
	return r.Ticket(ctx, id)
}
```

- [ ] **Step 4: Mount the GraphQL handler on Echo**

In `services/ticket-service/cmd/server/main.go`, add after the existing route setup:

```go
import (
	"github.com/99designs/gqlgen/graphql/handler"
	gqlhandler "<MODULE_PATH>/internal/graphql"
)

// After existing routes setup
gqlResolver := &gqlhandler.Resolver{TicketService: ticketService}
gqlSrv := handler.NewDefaultServer(gqlhandler.NewExecutableSchema(gqlhandler.Config{Resolvers: gqlResolver}))
e.POST("/graphql", echo.WrapHandler(gqlSrv))
```

- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
cd services/ticket-service && go test ./internal/graphql/ -run TestTicketQuery -v
```

Expected: PASS.

- [ ] **Step 6: Verify the service builds**

Run:

```bash
cd services/ticket-service && go build ./cmd/server/
```

Expected: compiles without errors.

- [ ] **Step 7: Commit**

```bash
git add services/ticket-service/internal/graphql/ services/ticket-service/cmd/server/main.go
git commit -m "feat(ticket): implement gqlgen federation resolvers

Ticket entity resolution, list/get queries, mutations.
Delegates to existing TicketService. Mounted on /graphql.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 13: payment-service subgraph — schema, resolver, tests

**Files:**
- Create: `services/payment-service/src/graphql/schema.graphql`
- Create: `services/payment-service/src/graphql/payment.resolver.ts`
- Create: `services/payment-service/src/graphql/payment.resolver.spec.ts`
- Create: `services/payment-service/src/graphql/graphql.module.ts`
- Modify: `services/payment-service/package.json`
- Modify: `services/payment-service/src/app.module.ts`

- [ ] **Step 1: Create the payment subgraph SDL**

Create `services/payment-service/src/graphql/schema.graphql`:

```graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.9", import: ["@key", "@tag"])

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

scalar DateTime

type Query {
  payment(id: ID!): Payment
}

type Mutation {
  createPayment(input: CreatePaymentInput!): Payment!
}

input CreatePaymentInput {
  orderId: ID!
  token: String!
}
```

- [ ] **Step 2: Install GraphQL dependencies**

Run:

```bash
cd services/payment-service && pnpm add @nestjs/graphql @nestjs/apollo @apollo/subgraph graphql @apollo/server
```

- [ ] **Step 3: Write the failing resolver test**

Create `services/payment-service/src/graphql/payment.resolver.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentResolver } from './payment.resolver';

describe('PaymentResolver', () => {
  let resolver: PaymentResolver;
  const mockPaymentsService = {
    findPaymentById: vi.fn(),
    findPaymentByOrderId: vi.fn(),
  };

  beforeEach(() => {
    resolver = new PaymentResolver(mockPaymentsService as any);
    vi.clearAllMocks();
  });

  describe('payment query', () => {
    it('returns payment when requester owns the payment', async () => {
      const payment = { id: 'pay-1', userId: 'user-123', orderId: 'ord-1', amount: 5000, currency: 'usd', status: 'CAPTURED' };
      mockPaymentsService.findPaymentById.mockResolvedValue(payment);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.payment('pay-1', ctx);

      expect(result).toEqual(payment);
    });

    it('returns null when requester does not own the payment', async () => {
      const payment = { id: 'pay-1', userId: 'user-123', orderId: 'ord-1', amount: 5000, currency: 'usd', status: 'CAPTURED' };
      mockPaymentsService.findPaymentById.mockResolvedValue(payment);

      const ctx = { req: { headers: { 'x-user-id': 'other-user' } } };
      const result = await resolver.payment('pay-1', ctx);

      expect(result).toBeNull();
    });
  });

  describe('resolveReference', () => {
    it('resolves a Payment entity by id', async () => {
      const payment = { id: 'pay-1', userId: 'user-123', amount: 5000 };
      mockPaymentsService.findPaymentById.mockResolvedValue(payment);

      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'pay-1' });
      expect(result).toEqual(payment);
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
cd services/payment-service && pnpm test -- --run src/graphql/payment.resolver.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 5: Implement the resolver**

Create `services/payment-service/src/graphql/payment.resolver.ts`:

```typescript
import { Resolver, Query, ResolveReference, Args, Context } from '@nestjs/graphql';
import { PaymentsService } from '../modules/payments/payments.service';

@Resolver('Payment')
export class PaymentResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Query()
  async payment(@Args('id') id: string, @Context() ctx: any) {
    const payment = await this.paymentsService.findPaymentById(id);
    if (!payment) return null;
    if (payment.userId !== ctx.req.headers['x-user-id']) return null;
    return payment;
  }

  @ResolveReference()
  async resolveReference(reference: { __typename: string; id: string }) {
    return this.paymentsService.findPaymentById(reference.id);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
cd services/payment-service && pnpm test -- --run src/graphql/payment.resolver.spec.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 7: Create GraphQL module and wire into app**

Create `services/payment-service/src/graphql/graphql.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { PaymentResolver } from './payment.resolver';
import { PaymentsModule } from '../modules/payments/payments.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      typePaths: [__dirname + '/schema.graphql'],
      playground: false,
    }),
    PaymentsModule,
  ],
  providers: [PaymentResolver],
})
export class PaymentGraphQLModule {}
```

In `services/payment-service/src/app.module.ts`, add:

```typescript
import { PaymentGraphQLModule } from './graphql/graphql.module';
```

Add `PaymentGraphQLModule` to the `imports` array.

- [ ] **Step 8: Verify the service builds**

Run:

```bash
cd services/payment-service && pnpm build
```

Expected: compiles without errors.

- [ ] **Step 9: Commit**

```bash
git add services/payment-service/src/graphql/ services/payment-service/src/app.module.ts services/payment-service/package.json services/payment-service/pnpm-lock.yaml
git commit -m "feat(payment): implement federation subgraph

Payment entity with self-only access control.
Delegates to existing PaymentsService.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 14: Recompose supergraph with 4 subgraphs

**Files:**
- Modify: `services/apollo-router/supergraph-config.yaml`

- [ ] **Step 1: Add ticket and payment subgraphs to supergraph-config.yaml**

Update `services/apollo-router/supergraph-config.yaml`:

```yaml
federation_version: =2.9
subgraphs:
  auth:
    routing_url: http://auth-service:3000/graphql
    schema:
      file: ../auth-service/src/graphql/schema.graphql
  users:
    routing_url: http://user-service:3004/graphql
    schema:
      file: ../user-service/src/graphql/schema.graphql
  tickets:
    routing_url: http://ticket-service:3001/graphql
    schema:
      file: ../ticket-service/internal/graphql/schema.graphqls
  payments:
    routing_url: http://payment-service:3002/graphql
    schema:
      file: ../payment-service/src/graphql/schema.graphql
```

- [ ] **Step 2: Recompose and verify**

Run:

```bash
cd services/apollo-router && ~/.rover/bin/rover supergraph compose \
  --config supergraph-config.yaml \
  --output supergraph.graphql
```

Expected: exits 0 with no composition errors.

- [ ] **Step 3: Test cross-subgraph entity resolution**

Restart the stack and test a query that spans subgraphs:

```bash
docker-compose up -d
```

```bash
curl -X POST http://localhost:8000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JWT>" \
  -d '{"query": "{ currentUser { id email profile { displayName } } }"}'
```

Expected: Router resolves `User.id` and `User.email` from auth-service, then sends entity resolution query to user-service for `profile`.

- [ ] **Step 4: Commit**

```bash
git add services/apollo-router/supergraph-config.yaml
git commit -m "feat(graphql): add ticket + payment to supergraph composition

4 subgraphs: auth, user, ticket, payment. Cross-subgraph
entity resolution validated.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 15: venue-service subgraph — gqlgen setup, schema, resolvers

**Files:**
- Create: `services/venue-service/gqlgen.yml`
- Create: `services/venue-service/internal/graphql/schema.graphqls`
- Modify: `services/venue-service/go.mod`
- Modify: `services/venue-service/cmd/server/main.go`

- [ ] **Step 1: Add gqlgen dependency**

Run:

```bash
cd services/venue-service && go get github.com/99designs/gqlgen@latest
```

- [ ] **Step 2: Create gqlgen.yml**

Create `services/venue-service/gqlgen.yml`:

```yaml
schema:
  - internal/graphql/schema.graphqls

exec:
  filename: internal/graphql/generated.go
  package: graphql

model:
  filename: internal/graphql/model.go
  package: graphql

resolver:
  layout: follow-schema
  dir: internal/graphql
  package: graphql
  filename_template: "{name}.resolvers.go"

federation:
  filename: internal/graphql/federation.go
  package: graphql
  version: 2
```

- [ ] **Step 3: Create the venue subgraph SDL**

Create `services/venue-service/internal/graphql/schema.graphqls`:

```graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.9", import: ["@key"])

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

enum AssignmentMode {
  MANUAL
  AUTO
}

enum SeatStatus {
  AVAILABLE
  HELD
  SOLD
}

enum PlanStatus {
  DRAFT
  ACTIVE
  ARCHIVED
}

type Query {
  seatingPlan(id: ID!): SeatingPlan
}
```

- [ ] **Step 4: Generate gqlgen code**

Run:

```bash
cd services/venue-service && go run github.com/99designs/gqlgen generate
```

- [ ] **Step 5: Implement resolvers**

Edit the generated resolver file to implement:

```go
func (r *queryResolver) SeatingPlan(ctx context.Context, id string) (*SeatingPlan, error) {
	plan, err := r.PlanRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	return mapPlanToGraphQL(plan), nil
}

func (r *entityResolver) FindSeatingPlanByID(ctx context.Context, id string) (*SeatingPlan, error) {
	return r.SeatingPlan(ctx, id)
}
```

Mount on Echo in `cmd/server/main.go`:

```go
gqlResolver := &gqlhandler.Resolver{PlanRepo: planRepo, SectionRepo: sectionRepo}
gqlSrv := handler.NewDefaultServer(gqlhandler.NewExecutableSchema(gqlhandler.Config{Resolvers: gqlResolver}))
e.POST("/graphql", echo.WrapHandler(gqlSrv))
```

- [ ] **Step 6: Write test and verify**

Create `services/venue-service/internal/graphql/resolver_test.go` with a test similar to Task 12's pattern — mock the repository, send a GraphQL query via httptest, assert the response.

Run:

```bash
cd services/venue-service && go test ./internal/graphql/ -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/venue-service/gqlgen.yml services/venue-service/internal/graphql/ services/venue-service/cmd/server/main.go services/venue-service/go.mod services/venue-service/go.sum
git commit -m "feat(venue): implement gqlgen federation subgraph

SeatingPlan entity with sections and seats.
Mounted on /graphql alongside existing REST/gRPC.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 16: order-service subgraph — Spring GraphQL setup and schema

> **Implementation note:** This task was implemented using Spring GraphQL (`@Controller` + `@QueryMapping`/`@SchemaMapping`) instead of Netflix DGS as originally planned. The deviation is documented in the spec.

**Files:**
- Modify: `services/order-service/pom.xml`
- Create: `services/order-service/src/main/resources/schema/schema.graphqls`

- [ ] **Step 1: Add Spring GraphQL dependency to pom.xml**

In `services/order-service/pom.xml`, add to the `<dependencies>` section:

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-graphql</artifactId>
</dependency>
<dependency>
    <groupId>com.apollographql.federation</groupId>
    <artifactId>federation-graphql-java-support</artifactId>
</dependency>
```

- [ ] **Step 2: Create the order subgraph SDL**

Create `services/order-service/src/main/resources/schema/schema.graphqls`:

```graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.9", import: ["@key", "@tag"])

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
  orders: [Order!]! @tag(name: "self-only")
}

type Ticket @key(fields: "id", resolvable: false) {
  id: ID!
}

type Payment @key(fields: "id", resolvable: false) {
  id: ID!
}

enum OrderStatus {
  PENDING
  AWAITING_PAYMENT
  COMPLETED
  CANCELLED
}

scalar DateTime

type Query {
  order(id: ID!): Order
  orders: [Order!]!
}

type Mutation {
  createOrder(input: CreateOrderInput!): Order!
  cancelOrder(id: ID!): Order!
}

input CreateOrderInput {
  ticketId: ID!
  quantity: Int!
}
```

- [ ] **Step 3: Verify Maven compiles**

Run:

```bash
cd services/order-service && ./mvnw compile
```

Expected: compiles without errors. Spring GraphQL auto-discovers the schema file from `resources/graphql/`.

- [ ] **Step 4: Commit**

```bash
git add services/order-service/pom.xml services/order-service/src/main/resources/schema/schema.graphqls
git commit -m "feat(order): add Spring GraphQL dependency and federation subgraph schema

Order entity with User, Ticket, Payment references.
Self-only User.orders field.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 17: order-service subgraph — Spring GraphQL controller with tests

**Files:**
- Create: `services/order-service/src/main/java/com/ticketing/orders/graphql/OrderGraphqlController.java`
- Create: `services/order-service/src/main/java/com/ticketing/orders/graphql/FederationConfig.java`
- Create: `services/order-service/src/main/java/com/ticketing/orders/graphql/UserIdInterceptor.java`
- Create: `services/order-service/src/test/java/com/ticketing/orders/graphql/OrderGraphqlControllerTest.java`

- [ ] **Step 1: Write the failing Spring GraphQL test**

Create `services/order-service/src/test/java/com/ticketing/orders/graphql/OrderGraphqlControllerTest.java`:

```java
package com.ticketing.orders.graphql;

import com.ticketing.orders.service.OrderService;
import com.ticketing.orders.dto.OrderResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.graphql.tester.AutoConfigureHttpGraphQlTester;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.graphql.test.tester.HttpGraphQlTester;

import java.util.List;
import java.util.UUID;

import static org.mockito.Mockito.when;

@SpringBootTest
@AutoConfigureHttpGraphQlTester
class OrderGraphqlControllerTest {

    @Autowired
    HttpGraphQlTester graphQlTester;

    @MockBean
    OrderService orderService;

    @Test
    void ordersQueryReturnsUserOrders() {
        UUID userId = UUID.fromString("00000000-0000-0000-0000-000000000001");
        OrderResponse order = new OrderResponse();
        order.setId(UUID.randomUUID());
        order.setUserId(userId);
        order.setStatus("PENDING");
        order.setQuantity(1);
        order.setTotalPrice(5000);

        when(orderService.listOrders(userId)).thenReturn(List.of(order));

        graphQlTester.mutate()
            .header("X-User-Id", userId.toString())
            .build()
            .document("{ orders { status } }")
            .execute()
            .path("orders[0].status")
            .entity(String.class)
            .isEqualTo("PENDING");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd services/order-service && ./mvnw test -pl . -Dtest=OrderGraphqlControllerTest
```

Expected: FAIL — classes not found.

- [ ] **Step 3: Implement OrderGraphqlController**

Create `services/order-service/src/main/java/com/ticketing/orders/graphql/OrderGraphqlController.java`:

```java
package com.ticketing.orders.graphql;

import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.service.OrderService;
import graphql.GraphQLContext;
import org.springframework.graphql.data.method.annotation.Argument;
import org.springframework.graphql.data.method.annotation.MutationMapping;
import org.springframework.graphql.data.method.annotation.QueryMapping;
import org.springframework.graphql.data.method.annotation.SchemaMapping;
import org.springframework.stereotype.Controller;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Controller("orderGraphqlController")
public class OrderGraphqlController {

    private final OrderService orderService;

    public OrderGraphqlController(OrderService orderService) {
        this.orderService = orderService;
    }

    @QueryMapping
    public List<OrderResponse> orders(GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        return orderService.listOrders(UUID.fromString(userId));
    }

    @QueryMapping
    public OrderResponse order(@Argument String id, GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        return orderService.getOrder(UUID.fromString(id), UUID.fromString(userId));
    }

    @MutationMapping
    public OrderResponse createOrder(@Argument CreateOrderRequest input, GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        return orderService.createOrder(UUID.fromString(userId), input);
    }

    @MutationMapping
    public OrderResponse cancelOrder(@Argument String id, GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        return orderService.cancelOrder(UUID.fromString(id), UUID.fromString(userId));
    }

    @SchemaMapping(typeName = "User", field = "orders")
    public List<OrderResponse> userOrders(Map<String, Object> user, GraphQLContext ctx) {
        String userId = (String) user.get("id");
        String requesterId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        if (!userId.equals(requesterId)) return List.of();
        return orderService.listOrders(UUID.fromString(userId));
    }
}
```

- [ ] **Step 4: Implement FederationConfig**

Create `services/order-service/src/main/java/com/ticketing/orders/graphql/FederationConfig.java` to wire federation entity resolution via `federation-graphql-java-support`.

- [ ] **Step 5: Implement UserIdInterceptor**

Create `services/order-service/src/main/java/com/ticketing/orders/graphql/UserIdInterceptor.java` as a `WebGraphQlInterceptor` that reads `X-User-Id` from the HTTP request headers and stores it in the `GraphQLContext`.

- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
cd services/order-service && ./mvnw test -pl . -Dtest=OrderGraphqlControllerTest
```

Expected: PASS.

- [ ] **Step 7: Verify the service builds**

Run:

```bash
cd services/order-service && ./mvnw compile
```

Expected: compiles without errors.

- [ ] **Step 8: Commit**

```bash
git add services/order-service/src/main/java/com/ticketing/orders/graphql/ services/order-service/src/test/java/com/ticketing/orders/graphql/
git commit -m "feat(order): implement Spring GraphQL federation controller

Order queries/mutations, entity resolution, self-only User.orders.
Uses @Controller + @QueryMapping/@SchemaMapping (Spring-native, no DGS).
Delegates to existing OrderService.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 18: Final supergraph composition — all 6 subgraphs

**Files:**
- Modify: `services/apollo-router/supergraph-config.yaml`

- [ ] **Step 1: Add venue and order subgraphs**

Update `services/apollo-router/supergraph-config.yaml` to its final form:

```yaml
federation_version: =2.9
subgraphs:
  auth:
    routing_url: http://auth-service:3000/graphql
    schema:
      file: ../auth-service/src/graphql/schema.graphql
  users:
    routing_url: http://user-service:3004/graphql
    schema:
      file: ../user-service/src/graphql/schema.graphql
  tickets:
    routing_url: http://ticket-service:3001/graphql
    schema:
      file: ../ticket-service/internal/graphql/schema.graphqls
  payments:
    routing_url: http://payment-service:3002/graphql
    schema:
      file: ../payment-service/src/graphql/schema.graphql
  venues:
    routing_url: http://venue-service:3003/graphql
    schema:
      file: ../venue-service/internal/graphql/schema.graphqls
  orders:
    routing_url: http://order-service:8082/graphql
    schema:
      file: ../order-service/src/main/resources/schema/schema.graphqls
```

- [ ] **Step 2: Compose and verify**

Run:

```bash
cd services/apollo-router && ~/.rover/bin/rover supergraph compose \
  --config supergraph-config.yaml \
  --output supergraph.graphql
```

Expected: exits 0 — all 6 subgraphs compose without conflicts.

- [ ] **Step 3: Full stack end-to-end test**

```bash
docker-compose up -d
```

Test a multi-hop query spanning 4 subgraphs:

```bash
curl -X POST http://localhost:8000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JWT>" \
  -d '{
    "query": "{ currentUser { id email profile { displayName } orders { id status ticket { id title price } payment { id status amount } } } }"
  }'
```

Expected: Router resolves User from auth-service, profile from user-service, orders from order-service, ticket details from ticket-service, and payment details from payment-service — all in a single response.

- [ ] **Step 4: Commit**

```bash
git add services/apollo-router/supergraph-config.yaml
git commit -m "feat(graphql): complete supergraph with all 6 subgraphs

Full federation: auth, user, ticket, payment, venue, order.
Multi-hop entity resolution validated.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 19: Frontend GraphQL client setup (Next.js)

**Files:**
- Modify: `services/client/package.json`
- Create: `services/client/src/lib/graphql-client.ts`

- [ ] **Step 1: Install urql (lightweight GraphQL client)**

Run:

```bash
cd services/client && pnpm add urql graphql @urql/next
```

- [ ] **Step 2: Create the GraphQL client**

Create `services/client/src/lib/graphql-client.ts`:

```typescript
import { cacheExchange, createClient, fetchExchange } from 'urql';

export function createGraphQLClient(cookie?: string) {
  return createClient({
    url: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/graphql`,
    exchanges: [cacheExchange, fetchExchange],
    fetchOptions: () => ({
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }),
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add services/client/src/lib/graphql-client.ts services/client/package.json services/client/pnpm-lock.yaml
git commit -m "feat(client): add urql GraphQL client for federation gateway

Configured for Kong /graphql endpoint with cookie-based auth.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 20: Frontend — migrate one page to GraphQL

**Files:**
- Identify an existing page that fetches order details (likely in `services/client/src/app/orders/[id]/page.tsx` or similar)
- Create a GraphQL query alongside the existing REST fetch

- [ ] **Step 1: Identify the target page**

Look for the order detail page:

```bash
find services/client/src/app -name "page.tsx" | grep -i order
```

- [ ] **Step 2: Create the GraphQL query and Server Component**

In the order detail page directory, add a GraphQL-powered data fetch:

```typescript
import { createGraphQLClient } from '@/lib/graphql-client';
import { cookies } from 'next/headers';

const ORDER_DETAIL_QUERY = `
  query OrderDetail($id: ID!) {
    order(id: $id) {
      id
      status
      quantity
      totalPrice
      createdAt
      ticket {
        id
        title
        price
      }
      payment {
        id
        status
        amount
        currency
      }
    }
  }
`;

async function getOrderViaGraphQL(orderId: string) {
  const cookieStore = await cookies();
  const client = createGraphQLClient(cookieStore.toString());
  const result = await client.query(ORDER_DETAIL_QUERY, { id: orderId });
  return result.data?.order;
}
```

This replaces what would previously be 3+ separate REST calls (order, ticket, payment) with a single GraphQL query.

- [ ] **Step 3: Test in the browser**

Start the dev server:

```bash
cd services/client && pnpm dev
```

Navigate to an order detail page and verify the data loads correctly from GraphQL.

- [ ] **Step 4: Commit**

```bash
git add services/client/
git commit -m "feat(client): migrate order detail page to GraphQL

Single query replaces 3 REST calls for order + ticket + payment.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
