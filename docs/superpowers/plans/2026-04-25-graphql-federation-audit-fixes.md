# Implementation Plan: GraphQL Federation Audit Remediation

**Issue:** #49  
**Date:** 2026-04-25  
**Prerequisite:** Merge `feature/graphql-federation` PR first, then execute fixes on a new branch.  
**Branch name:** `fix/issue-49-graphql-federation-audit`  
**Estimated effort:** 5–7 days across 3 phases

---

## Phase 1 — Critical Fixes (P0) — Unblocks Staging

### Step 1: Remove Rhai JWT script from Helm router config (P0-1)

**Goal:** Eliminate unvalidated JWT extraction in Kubernetes-deployed router.

**Files to change:**
- `infra/helm/charts/apollo-router/files/router.yaml` — remove the `rhai:` block (lines 5–7)
- `infra/helm/charts/apollo-router/templates/configmap.yaml` — remove the `jwt_cookie.rhai` data entry if present
- `infra/helm/charts/apollo-router/templates/deployment.yaml` — remove the script volume mount if separate from config

**Keep unchanged:**
- `services/apollo-router/router.yaml` — local dev config, keep Rhai script here for docker-compose

**Verification:**
- `helm template` renders configmap without Rhai script reference
- `helm lint` passes
- Docker-compose local dev still works with Rhai script

---

### Step 2: Add auth guards to all entity resolvers (P0-2)

**Goal:** Every `@ResolveReference()` / `_entities` call validates identity signature.

#### 2a. auth-service (NestJS)

**File:** `services/auth-service/src/graphql/auth.resolver.ts`

```typescript
// Add @UseGuards(UserIdSigGuard) to resolveReference
@ResolveReference()
@UseGuards(UserIdSigGuard)
async resolveReference(reference: { __typename: string; id: string }) {
  return this.usersRepository.findById(reference.id);
}
```

**Test:** `services/auth-service/src/graphql/auth.resolver.spec.ts`
- Add test: entity resolution with invalid signature → throws UnauthorizedException
- Add test: entity resolution without x-user-id → passes (public entity stub)

#### 2b. user-service (NestJS)

**File:** `services/user-service/src/graphql/user.resolver.ts`

Same pattern: add `@UseGuards(UserIdSigGuard)` to `@ResolveReference()`.

**Test:** `services/user-service/src/graphql/user.resolver.spec.ts`

#### 2c. payment-service (NestJS)

**File:** `services/payment-service/src/graphql/payment.resolver.ts`

Same pattern. Additionally, add ownership check to `resolveReference()`:

```typescript
@ResolveReference()
@UseGuards(UserIdSigGuard)
async resolveReference(
  reference: { __typename: string; id: string },
  @Context() ctx: GqlContext,
) {
  const payment = await this.paymentsService.findById(reference.id);
  // Federation calls come from router with x-user-id set
  // Only return payment if requester owns it
  const requesterId = ctx.req.headers['x-user-id'] as string;
  if (requesterId && payment.userId !== requesterId) return null;
  return payment;
}
```

**Test:** `services/payment-service/src/graphql/payment.resolver.spec.ts`
- Add test: entity resolution for payment owned by different user → returns null

#### 2d. order-service (Spring)

**File:** `services/order-service/src/main/java/com/ticketing/orders/graphql/FederationConfig.java`

Add user context check to `fetchEntities()`. The `UserIdInterceptor` already puts `x-user-id` into `GraphQLContext`; verify it's available in the entity fetcher's `DataFetchingEnvironment`:

```java
// In fetchEntities lambda, get userId from GraphQLContext
String requesterId = env.getGraphQlContext().get(UserIdInterceptor.USER_ID_KEY);

// For Order entities, filter by ownership
if ("Order".equals(typename)) {
    OrderResponse order = orderMap.get(UUID.fromString(id));
    if (order != null && requesterId != null
        && !order.getUserId().toString().equals(requesterId)) {
        return null; // Not owner
    }
    return order;
}
```

**Test:** `services/order-service/src/test/java/com/ticketing/orders/graphql/OrderControllerTest.java`

#### 2e. ticket-service (Go)

**File:** `services/ticket-service/internal/graphql/entity.resolvers.go`

Ticket entities are public read (mirrors REST GET), so the entity resolver can remain unguarded. However, the HTTP middleware that wraps the GraphQL handler should validate `x-user-id-sig` if `x-user-id` is present (same as venue-service pattern).

**Verify:** `services/ticket-service/cmd/server/main.go` — confirm the GraphQL handler is wrapped with signature validation middleware.

#### 2f. venue-service (Go)

**File:** `services/venue-service/internal/graphql/entity.resolvers.go`

SeatingPlan entities are public read (mirrors REST GET), so entity resolver can remain unguarded. The `WrapWithUserIDSignatureValidation` middleware already exists in `auth.go` — verify it wraps the GraphQL handler in `cmd/server/main.go`.

**Verify:** `services/venue-service/cmd/server/main.go` — confirm GraphQL handler wrapped.

---

### Step 3: Replace string comparison with timing-safe equivalents (P0-3)

**Goal:** All HMAC validators use constant-time comparison.

#### 3a. TypeScript (auth, user, payment services)

**Files:**
- `services/auth-service/src/common/security/user-id-signature.validator.ts`
- `services/user-service/src/common/security/user-id-signature.validator.ts`
- `services/payment-service/src/common/security/user-id-signature.validator.ts`

**Change:**
```typescript
// Before
if (expectedCurrent === signature) {
  return true;
}

// After
import crypto from 'crypto';
// ...
if (crypto.timingSafeEqual(Buffer.from(expectedCurrent), Buffer.from(signature))) {
  return true;
}
```

Note: `timingSafeEqual` throws if buffers are different lengths. Add length check first:
```typescript
private safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
```

**Tests:** Existing tests should pass unchanged (behavior is identical, only timing changes).

#### 3b. Java (order-service)

**File:** `services/order-service/src/main/java/com/ticketing/orders/security/UserIdSignatureValidator.java`

**Change:**
```java
// Before
if (expectedCurrent.equals(signature)) {

// After
if (MessageDigest.isEqual(
    expectedCurrent.getBytes(StandardCharsets.UTF_8),
    signature.getBytes(StandardCharsets.UTF_8))) {
```

#### 3c. Go (ticket-service, venue-service)

**Files:**
- `services/ticket-service/internal/security/user_id_signature.go`
- `services/venue-service/internal/security/user_id_signature.go`

**Change:**
```go
// Before
if expectedCurrent == signature {

// After
if hmac.Equal([]byte(expectedCurrent), []byte(signature)) {
```

Import `crypto/hmac` is already present (used for `hmac.New`).

---

## Phase 2 — High Fixes (P1) — Unblocks Production

### Step 4: Disable introspection in production (P1-1)

**Files:**
- `infra/helm/charts/apollo-router/files/router.yaml` — add:
  ```yaml
  supergraph:
    introspection: false
  ```
- `services/apollo-router/router.yaml` — keep introspection enabled (local dev)

**Verification:** `curl -X POST http://router/graphql -d '{"query":"{ __schema { types { name } } }"}'` returns error.

---

### Step 5: Add query depth and complexity limits (P1-2)

**File:** `infra/helm/charts/apollo-router/files/router.yaml`

```yaml
limits:
  max_depth: 15
  max_height: 200
  max_aliases: 30
  max_root_fields: 20
```

Also add to `services/apollo-router/router.yaml` for local dev parity.

**Verification:** E2E test with deeply nested query (depth > 15) returns error.

---

### Step 6: Enable NetworkPolicy by default (P1-3)

**Files:**
- `infra/helm/charts/apollo-router/values.yaml` — change `networkPolicy.enabled: true`
- `infra/helm/values-local.yaml` — add override: `apollo-router.networkPolicy.enabled: false`
- Add destination pod selectors to egress rules in `templates/networkpolicy.yaml`

**Verification:** `helm template` with default values renders NetworkPolicy. `helm template -f values-local.yaml` does not.

---

### Step 7: Restrict CORS to specific origins (P1-4)

**File:** `services/kong-gateway/config/kong.base.yml`

Replace wildcard in GraphQL route CORS:
```yaml
cors:
  origins: ["{{CORS_ALLOWED_ORIGINS}}"]
  credentials: true
  methods: [POST, OPTIONS]
  headers: [Content-Type, Authorization]
```

**Files:**
- `services/kong-gateway/values/_defaults.yml` — add `CORS_ALLOWED_ORIGINS: "*"` (dev default)
- `services/kong-gateway/values/prod.yml` — add specific origins
- `services/kong-gateway/values/staging.yml` — add specific origins

---

### Step 8: Fail at startup if signing key empty in production (P1-5)

#### 8a. TypeScript (auth, user, payment)

Add startup validation in each service's `app.module.ts` config schema:

```typescript
X_USER_ID_SIGNING_KEY: z.string().min(1, 'X_USER_ID_SIGNING_KEY is required'),
```

Or conditionally based on NODE_ENV:
```typescript
X_USER_ID_SIGNING_KEY: process.env.NODE_ENV === 'production'
  ? z.string().min(32)
  : z.string().default(''),
```

#### 8b. Java (order-service)

Add `@PostConstruct` validation in `UserIdSignatureValidator`:
```java
@PostConstruct
void validateConfiguration() {
  String env = System.getenv("SPRING_PROFILES_ACTIVE");
  if ("production".equals(env) && signingKey.isEmpty()) {
    throw new IllegalStateException("X_USER_ID_SIGNING_KEY must be set in production");
  }
}
```

#### 8c. Go (ticket, venue)

Add startup check in `cmd/server/main.go` after reading config:
```go
if cfg.Environment == "production" && cfg.UserIDSigningKey == "" {
  log.Fatal("X_USER_ID_SIGNING_KEY must be set in production")
}
```

---

## Phase 3 — Hardening (P2+) — Post-Launch Sprint

### Step 9: Remove Rhai block from Helm router config (P2-2)

Already done in Step 1 — verify no orphaned references.

---

### Step 10: Document or enforce `@tag` annotations (P2-3)

**Decision needed:** Either implement Apollo Router authorization policies for `@tag` enforcement, or remove the tags and document that field-level auth is in resolvers.

**Recommendation:** Keep tags as documentation. Add a comment to the supergraph schema:
```graphql
# NOTE: @tag annotations are informational only.
# Field-level authorization is enforced in subgraph resolvers.
```

---

### Step 11: Pin Dockerfile to image digest (P2-4)

**File:** `services/apollo-router/Dockerfile`

```dockerfile
FROM ghcr.io/apollographql/router:v2.1.1@sha256:<get-digest>
```

Run: `docker pull ghcr.io/apollographql/router:v2.1.1 && docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/apollographql/router:v2.1.1`

---

### Step 12: Add E2E tests for entity resolver auth and signature validation

**File:** `services/client/tests/e2e/graphql-federation.spec.ts`

Add test cases:
1. **Tampered `x-user-id-sig`** — send valid JWT but modify the signature header → subgraph rejects
2. **Cross-user entity resolution** — user A queries user B's orders → empty result
3. **Query depth exceeds limit** — deeply nested query → router error (after Step 5)
4. **Introspection blocked** — `__schema` query → error (after Step 4)

---

### Step 13: Minor hardening

- P3-1: Add `if (signingKey.length < 32) throw` to all validators
- P3-2: Add `x-user-id-sig` to NestJS logger redaction lists
- P3-3: Verify mutation resolvers in ticket/venue have auth at subgraph level (defense in depth)

---

## Execution Order

```
Phase 1 (Critical — ~2 days):
  Step 1 (Rhai removal)     → Step 2a-2f (entity guards)    → Step 3a-3c (timing-safe)
  ─────────────────────────────────────────────────────────────────────────────────────
  Parallelize: 2a-2c (NestJS) in parallel with 2d (Java), 2e-2f (Go), 3a-3c

Phase 2 (High — ~2 days):
  Step 4 (introspection)    → Step 5 (depth limits)          → Step 6 (netpol)
  Step 7 (CORS)             → Step 8a-8c (startup validation)
  ─────────────────────────────────────────────────────────────────────────────────────
  Steps 4-8 are independent; all can be parallelized.

Phase 3 (Hardening — ~2 days):
  Step 10 (tags)            → Step 11 (digest pin)           → Step 12 (E2E tests)
  Step 13 (minor)
```

---

## Commit Strategy

Use conventional commits on branch `fix/issue-49-graphql-federation-audit`:

```
fix(security): remove unvalidated Rhai JWT script from Helm router config
fix(security): add auth guards to all federation entity resolvers
fix(security): use timing-safe HMAC comparison in all signature validators
fix(graphql): disable introspection in production router config
fix(graphql): add query depth and complexity limits to router
fix(security): enable NetworkPolicy by default for apollo-router
fix(security): restrict CORS to explicit origins on GraphQL route
fix(security): fail at startup if signing key empty in production
chore(security): pin apollo-router Dockerfile to image digest
test(e2e): add entity resolver auth and signature validation tests
```

Each commit should be independently deployable. PR references #49.
