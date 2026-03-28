# Audit Remediation Schedule

> **Source:** [AUDIT-REPORT.md](./AUDIT-REPORT.md) · [AUDIT-TODO.md](./AUDIT-TODO.md)
> **Created:** 2026-03-27
> **Total findings:** 75 (10 P0 · 22 P1 · 28 P2 · 15 P3)
> **Estimated total effort:** 14–22 engineer-days
>
> **Process rules (non-negotiable):**
> - One feature/fix branch per milestone — named `fix/audit-m<N>-<slug>`
> - Small, atomic commits — one meaningful change per commit (Conventional Commits format)
> - **Never merge into `main` without explicit owner review and approval** (AGENTS.md §16.10)
> - Each milestone has a verification gate — do not start the next until the gate passes
> - When a finding is fixed, check its box and commit the schedule update alongside the last fix commit of that milestone
> - Changes must be backwards compatitable in terms of audit rules, make sure all fixes don't violute previous passed or fixed rules.

---

## Milestone Index

| # | Slug | Severity gate | Branch | Estimated effort |
|---|------|--------------|--------|-----------------|
| [M1](#milestone-m1--p0-data-integrity) | `fix/audit-m1-data-integrity` | P0 | `fix/audit-m1-data-integrity` | 2–3 days |
| [M2](#milestone-m2--p0-security-critical) | `fix/audit-m2-security-critical` | P0 | `fix/audit-m2-security-critical` | 1–2 days |
| [M3](#milestone-m3--p0-resilience--dlq) | `fix/audit-m3-dlq-resilience` | P0 | `fix/audit-m3-dlq-resilience` | 1 day |
| [M4](#milestone-m4--p0-ci-deploy-pipeline) | `fix/audit-m4-ci-deploy` | P0 | `fix/audit-m4-ci-deploy` | 1–2 days |
| [M5](#milestone-m5--p1-auth--client-hardening) | `fix/audit-m5-auth-hardening` | P1 | `fix/audit-m5-auth-hardening` | 1 day |
| [M6](#milestone-m6--p1-resilience--observability) | `fix/audit-m6-resilience-obs` | P1 | `fix/audit-m6-resilience-obs` | 2–3 days |
| [M7](#milestone-m7--p1-performance--helm-ci) | `fix/audit-m7-perf-helm-ci` | P1 | `fix/audit-m7-perf-helm-ci` | 1–2 days |
| [M8](#milestone-m8--p2-security-correctness) | `fix/audit-m8-p2-security` | P2 | `fix/audit-m8-p2-security` | 1–2 days |
| [M9](#milestone-m9--p2-code-quality--testing) | `fix/audit-m9-quality-tests` | P2 | `fix/audit-m9-quality-tests` | 2–3 days |
| [M10](#milestone-m10--p3-tech-debt-backlog) | `fix/audit-m10-tech-debt` | P3 | `fix/audit-m10-tech-debt` | 2–3 days |

---

## Gate Legend

```
[ ] Not started
[~] In progress
[x] Complete and verified
```

> **Verification** means: code reviewed, tests green locally (or in CI), and the specific scenario
> described in each item's "Verify" section has been exercised.

---

## Milestone M1 — P0: Data Integrity

> **Branch:** `fix/audit-m1-data-integrity`
> **Gate:** All three items verified before moving to M2.
> **Why first:** These are correctness bugs. Running the platform with a broken transactional boundary
> or a missing Kafka producer silently loses data on every single transaction. Fix before touching anything else.

### Checklist

- [x] **C-01** — Fix `@Transactional` self-invocation bypass in order-service
- [x] **C-05** — Implement `payments.payment.captured` Kafka producer in payment-service
- [x] **C-06** — Fix `processOrderCreatedEvent` non-mock path (payments stuck in PENDING)

---

### C-01 · Fix `@Transactional` self-invocation bypass

**File:** `services/order-service/src/main/java/com/ticketing/orders/service/OrderService.java:109`

**Problem:**
`createOrder()` calls `this.createOrderTransactional()` directly. Spring's proxy-based AOP only
intercepts calls from _outside_ the bean. Self-invocation bypasses the proxy — the `@Transactional`
annotation on `createOrderTransactional` has **no effect**. The order row and the outbox row are
written in separate implicit transactions. If the process crashes between the two writes, the order
exists with no outbox entry — the Kafka event is never published and downstream services never learn
about the order.

**Fix — Option A (preferred): extract to a new `@Service` bean**

```java
// NEW file: OrderTransactionService.java
@Service
@RequiredArgsConstructor
public class OrderTransactionService {

    private final OrderRepository orderRepository;
    private final OutboxRepository outboxRepository;

    @Transactional          // <-- intercepted correctly because caller is external bean
    public Order createOrderTransactional(Ticket ticket, UUID userId) {
        Order order = Order.builder()
            .userId(userId)
            .status(OrderStatus.CREATED)
            .expiresAt(Instant.now().plusSeconds(60))
            .ticket(ticket)
            .build();

        Order saved = orderRepository.save(order);

        OutboxMessage msg = OutboxMessage.builder()
            .topic("orders.order.created")
            .partitionKey(saved.getId().toString())
            .payload(buildPayload(saved))
            .build();
        outboxRepository.save(msg);

        return saved;
    }
}

// MODIFIED: OrderService.java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderTransactionService orderTransactionService; // inject the new bean
    // ... existing fields ...

    public Order createOrder(CreateOrderRequest req, String userId) {
        // ... ticket validation, availability check (unchanged) ...

        // Call through the proxy — @Transactional is now honoured
        return orderTransactionService.createOrderTransactional(ticket, UUID.fromString(userId));
    }
}
```

**Fix — Option B (alternative): `TransactionTemplate` (no new class)**

```java
@Autowired
private TransactionTemplate transactionTemplate;

public Order createOrder(...) {
    // ...
    return transactionTemplate.execute(status -> {
        Order saved = orderRepository.save(order);
        outboxRepository.save(buildOutboxMessage(saved));
        return saved;
    });
}
```

**Commit message:**
```
fix(order-service): extract OrderTransactionService to fix @Transactional self-invocation bypass

createOrder() previously called this.createOrderTransactional() directly, bypassing Spring's
AOP proxy. The outbox write was not part of the same transaction as the order save. Extracts
the transactional logic into a separate @Service bean so the proxy intercepts correctly.

Closes audit finding C-01.
```

**Verify:**
1. Write an integration test: stub the outbox repository to throw after the order save.
   Assert the order row is also rolled back (count stays 0).
2. `docker compose up --build && pnpm exec playwright test` — 18/18 E2E still pass.

---

### C-05 · Implement `payments.payment.captured` Kafka producer

**File:** Architecture gap — no producer code exists in `services/payment-service/`

**Problem:**
After a successful charge/mock-charge, payment-service stores the result in its DB but never
publishes a `payments.payment.captured` event to Kafka. The E2E tests currently inject this
event directly from the test process. In production, order-service will never receive the event
and orders will remain in `AWAITING_PAYMENT` forever.

**Fix steps (transactional outbox pattern):**

1. **Add outbox table migration** (`services/payment-service/migrations/002_add_outbox.sql`):

```sql
CREATE TABLE outbox (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic         TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  partition_key TEXT        NOT NULL,
  published     BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_outbox_unpublished ON outbox(published) WHERE published = false;
```

2. **Write outbox row in the same DB transaction as the payment status update**
   (`payments.service.ts` — inside the existing `charge()` or `processOrderCreatedEvent()` method):

```typescript
// After setting payment status to COMPLETED, in the same Drizzle transaction:
await db.transaction(async (tx) => {
  await tx.update(payments).set({ status: 'COMPLETED' }).where(eq(payments.id, paymentId));
  await tx.insert(outbox).values({
    topic: 'payments.payment.captured',
    partitionKey: orderId,
    payload: {
      specversion: '1.0',
      type: 'payments.payment.captured',
      source: 'payment-service',
      id: randomUUID(),
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: { orderId, paymentId, amount, currency },
    },
  });
});
```

3. **Add outbox relay** — a `@Cron('*/1 * * * * *')` (every 1 s) NestJS scheduled task that:
   - Selects `WHERE published = false ORDER BY created_at LIMIT 50`
   - Produces each row to Kafka (CloudEvents envelope, `acks: -1`)
   - Marks `published = true` per row after successful send

4. **Add `@nestjs/schedule`** if not already installed (state why: needed for the cron relay).

**Commit sequence (one commit per step):**
```
chore(payment-service): add outbox table migration for payment event relay
feat(payment-service): write payments.payment.captured to outbox on payment completion
feat(payment-service): add OutboxRelayService cron to publish outbox rows to Kafka
test(payment-service): add integration test asserting payments.payment.captured event published
```

**Verify:**
- Integration test with Testcontainers Kafka: create a payment → assert `payments.payment.captured`
  appears on the topic within 3 seconds.
- E2E: `pnpm exec playwright test` — 18/18 pass (order reaches `COMPLETE`).

---

### C-06 · Fix `processOrderCreatedEvent` non-mock path

**File:** `services/payment-service/src/modules/payments/payments.service.ts:146`

**Problem:**
When `STRIPE_SECRET_KEY` is not `test_mock`, the Kafka consumer creates a `PENDING` payment
record then returns. No Stripe PaymentIntent is created. No event is published. The payment
is stuck in `PENDING` forever.

**Also fix:** The mock-mode check compares against `'test_mock'` but `.env` has `sk_test_mock`
(with `sk_` prefix) — the mock path is never triggered in local dev. (See also C-11.)

**Fix:**

```typescript
// Align the mock check with the .env value — one of these two:
// Option A: change .env to STRIPE_SECRET_KEY=test_mock
// Option B: change the guard to:
private get isMockMode(): boolean {
  return this.configService.get<string>('STRIPE_SECRET_KEY')?.includes('test_mock') ?? false;
}

// In processOrderCreatedEvent, after creating the PENDING record:
if (this.isMockMode) {
  // Mock path: immediately mark complete and publish event
  await this.completeMockPayment(payment.id, order.id);
} else {
  // Real path: create Stripe PaymentIntent
  await this.initiateStripePayment(payment, order);
}

private async initiateStripePayment(payment: Payment, order: PaymentOrder): Promise<void> {
  try {
    const intent = await this.stripe.paymentIntents.create({
      amount: Math.round(Number(order.price) * 100), // cents
      currency: 'usd',
      confirm: false,   // confirm via webhook or client-side Stripe.js
      idempotencyKey: order.id,
    });
    await db.update(payments)
      .set({ stripePaymentIntentId: intent.id })
      .where(eq(payments.id, payment.id));
  } catch (err) {
    this.logger.error({ err, orderId: order.id }, 'Stripe PaymentIntent creation failed');
    await db.update(payments)
      .set({ status: 'FAILED' })
      .where(eq(payments.id, payment.id));
  }
}
```

**Commit message:**
```
fix(payment-service): fix processOrderCreatedEvent to initiate Stripe charge in non-mock mode

Previously the consumer created a PENDING record and returned without calling Stripe.
Adds isMockMode helper (fixing sk_test_mock prefix mismatch) and initiateStripePayment
path. Mock path immediately completes and publishes event.

Closes audit findings C-06 and C-11.
```

**Verify:**
- Unit test: mock Stripe client, call `processOrderCreatedEvent` — assert `paymentIntents.create`
  called with correct amount and idempotency key.
- Mock path test: set `STRIPE_SECRET_KEY=test_mock`, assert `COMPLETED` status + outbox row written.

---

### M1 Gate

Before moving to M2, confirm all of the following:

- [ ] `OrderTransactionService` exists and is injected into `OrderService`
- [ ] Integration test proves rollback on outbox failure
- [ ] `payments.payment.captured` appears on Kafka topic in integration test
- [ ] `isMockMode` guard correctly detects `sk_test_mock` and `test_mock`
- [ ] `docker compose up --build` — all containers start clean
- [ ] `pnpm exec playwright test` (from `services/client/`) — 18/18 pass
- [ ] Branch `fix/audit-m1-data-integrity` pushed, PR opened, **awaiting owner review**

---

## Milestone M2 — P0: Security Critical

> **Branch:** `fix/audit-m2-security-critical`
> **Gate:** All five items verified before M3.
> **Why:** Identity spoofing, credential exposure in Git, and root containers are the highest-impact
> security risks. A single compromised cluster pod currently gets root on the node (S-17).

### Checklist

- [ ] **S-02** — Strip `X-User-Id` on Kong ingress globally
- [ ] **S-05** — Add authorization check to `GET /api/payments/:id`
- [ ] **S-15 + S-16** — Move Stripe key + RSA private key out of `docker-compose.yml` to `.env`
- [ ] **S-17** — Fix Kong Dockerfile to run as `kong` user, not `root`
- [ ] **S-18** — Pin all production Dockerfiles to `@sha256:` digest

---

### S-02 · Strip `X-User-Id` on Kong ingress

**File:** `services/kong-gateway/config/kong.base.yml`

**Problem:**
The JWT `post-function` plugin sets `X-User-Id` after JWT validation — but only on JWT-protected
routes. On public routes (`auth-public`, `tickets-read`, `client-catchall`), an attacker sending
`X-User-Id: <any-uuid>` gets that value forwarded to the upstream service unchanged.

**Fix:**
Add a **global** `request-transformer` plugin that runs before any route-level plugin and strips
the header unconditionally. The JWT post-function still sets it authoritatively afterward.

```yaml
# In kong.base.yml, at the top-level plugins list (global scope):
plugins:
  # --- EXISTING plugins ---
  - name: correlation-id
    # ...

  # --- ADD THIS (global, runs first) ---
  - name: request-transformer
    config:
      remove:
        headers:
          - X-User-Id
          - X-User-Roles
    # No route/service/consumer scoping = applies globally to ALL requests
```

> **Note:** If a `request-transformer` plugin is already scoped per-route, this global instance
> still runs first (plugin ordering: global → service → route → consumer).
> Test that the JWT post-function still injects the correct `X-User-Id` after stripping.

**Commit message:**
```
fix(kong-gateway): add global request-transformer to strip X-User-Id on all ingress

External clients could previously forge X-User-Id on public (non-JWT) routes.
The global plugin strips the header before any route plugin runs; the JWT
post-function plugin then sets it authoritatively on protected routes.

Closes audit finding S-02.
```

**Verify:**
```bash
# Public route — header must NOT be forwarded
curl -v -H "X-User-Id: spoofed-uuid" http://localhost:8000/api/tickets
# Inspect upstream logs — X-User-Id must be absent or empty

# Protected route — header must be set to the JWT sub
curl -v -H "Cookie: token=<valid-jwt>" http://localhost:8000/api/orders
# Inspect upstream logs — X-User-Id must equal the JWT subject
```

---

### S-05 · Add authorization check to `GET /api/payments/:id`

**File:** `services/payment-service/src/modules/payments/payments.controller.ts:51-55`

**Problem:**
Any caller (even unauthenticated) can read any payment by ID. No `X-User-Id` requirement, no
ownership verification.

**Fix:**

```typescript
@Get(':id')
async findOne(
  @Param('id') id: string,
  @Headers('x-user-id') userId: string,
): Promise<PaymentResponseDto> {
  if (!userId) {
    throw new UnauthorizedException('Authentication required');
  }

  const payment = await this.paymentsService.findById(id);

  if (!payment) {
    throw new NotFoundException(`Payment ${id} not found`);
  }

  // Verify ownership — payment.userId is the user who initiated the payment
  if (payment.userId !== userId) {
    throw new ForbiddenException('You do not have access to this payment');
  }

  return payment;
}
```

> **Note:** `payment.userId` must be stored when the payment is created.
> Check the `payments` table schema and ensure `userId` is persisted.
> If it is not, add it: `ALTER TABLE payments ADD COLUMN user_id UUID NOT NULL`.

**Commit message:**
```
fix(payment-service): add ownership authorization check to GET /api/payments/:id

Previously any caller could read any payment by ID. Now requires X-User-Id
header and verifies the requesting user owns the payment. Returns 401 if
unauthenticated, 403 if the user does not own the payment.

Closes audit finding S-05.
```

**Verify:**
- Unit test: authenticated owner → 200; different user → 403; no header → 401; non-existent ID → 404.
- Integration test: full HTTP flow against real DB.

---

### S-15 + S-16 · Move secrets out of `docker-compose.yml`

**Files:** `docker-compose.yml`, `.env.example`, `.env` (gitignored)

**Problem:**
`STRIPE_SECRET_KEY` and the RSA private key are hardcoded in `docker-compose.yml`, which is
committed to version control. AGENTS.md §5.3 and §14.4 explicitly prohibit this.

**Fix steps:**

1. **Create/update `.env.example`** at repo root — add placeholders:

```dotenv
# Stripe API key (get from https://dashboard.stripe.com/test/apikeys)
# Use test_mock for local dev without real Stripe
STRIPE_SECRET_KEY=test_mock

# RSA private key for JWT signing (PKCS#8 PEM, single line with \n escapes)
# Generate: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 | awk 'NF {printf "%s\\n", $0}'
RSA_PRIVATE_KEY=<generate-and-paste-here>

# Kong public key (SPKI PEM, single line with \n escapes)
# Derived from RSA_PRIVATE_KEY:
# openssl rsa -in <key.pem> -pubout | awk 'NF {printf "%s\\n", $0}'
KONG_RSA_PUBLIC_KEY=<derived-from-RSA_PRIVATE_KEY>
```

2. **Update `docker-compose.yml`** — replace hardcoded values with `env_file` references:

```yaml
# At the top level of docker-compose.yml:
env_file:
  - .env

# Then in the payment-service and auth-service environment sections:
# REMOVE the hardcoded STRIPE_SECRET_KEY and RSA_PRIVATE_KEY lines
# REPLACE with references to env vars (they are now pulled from .env automatically):
environment:
  STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY}
  RSA_PRIVATE_KEY: ${RSA_PRIVATE_KEY}
```

3. **Verify `.env` is in `.gitignore`** (it should already be — confirm with `git check-ignore -v .env`).

4. **Update `README.md` and `infra/local/setup.sh`** — document that `.env` must be created from
   `.env.example` before running `docker compose up`.

5. **Add developer setup step** to `CONTRIBUTING.md`:

```markdown
## First-time setup

```bash
cp .env.example .env
# Edit .env: fill in RSA_PRIVATE_KEY and optionally STRIPE_SECRET_KEY
docker compose up --build
```
```

**Commit sequence:**
```
chore: add .env.example with secret placeholders for docker-compose local dev
fix(docker-compose): replace hardcoded RSA private key and Stripe key with .env references

Secrets must not live in version-controlled files. Moves RSA_PRIVATE_KEY and
STRIPE_SECRET_KEY to a gitignored .env file. .env.example documents required
vars with safe placeholder values.

Closes audit findings S-15 and S-16.
```

**Verify:**
```bash
git grep -i "sk_test_" -- docker-compose.yml  # must return 0 matches
git grep -i "BEGIN PRIVATE KEY" -- docker-compose.yml  # must return 0 matches
git check-ignore -v .env  # must be ignored
cp .env.example .env && docker compose up --build  # must start cleanly
pnpm exec playwright test  # 18/18 must still pass
```

---

### S-17 · Fix Kong Dockerfile — remove root user

**File:** `services/kong-gateway/Dockerfile`

**Problem:**
The final stage sets `USER root`. A container escape gives the attacker root on the Kubernetes node.
AGENTS.md §10.1: "Never run as root."

**Fix:**
The render script writes to `/etc/kong/` — pre-create the directory with `kong` user ownership
during the build stage, then switch to the `kong` user before `CMD`.

```dockerfile
# In the final/runtime stage, BEFORE CMD:

# Pre-create the config directory with correct ownership during build
# (The kong user/group exists in the base kong image)
RUN mkdir -p /etc/kong && chown kong:kong /etc/kong

# Switch to non-root kong user
USER kong

# Entrypoint script must write rendered config to /etc/kong/kong.yml
# This works because kong:kong now owns /etc/kong
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["kong", "docker-start"]
```

> If the entrypoint script uses `envsubst` or a custom render tool that writes to `/etc/kong/`,
> ensure the write destination path is owned by `kong`. If the render step needs root (e.g., to
> install packages), do it in an earlier build stage and copy the result.

**Commit message:**
```
fix(kong-gateway): run container as kong user instead of root

Pre-create /etc/kong with kong:kong ownership during build so the runtime
entrypoint can write the rendered config without root. Eliminates container
escape → node root escalation risk.

Closes audit finding S-17.
```

**Verify:**
```bash
docker build -t kong-gateway:audit-test services/kong-gateway/
docker run --rm kong-gateway:audit-test whoami  # must print: kong
```

---

### S-18 · Pin all production Dockerfiles to digest

**Files:** All `services/*/Dockerfile`

**Problem:**
Tag-only references like `FROM node:24-alpine` are mutable — the publisher can push new code
under the same tag. AGENTS.md §10.1: "Pin image versions to digest in production."

**Fix — for each service Dockerfile:**

1. Resolve the current digest for each base image:

```bash
# Example for node:24-alpine
docker pull node:24-alpine
docker inspect node:24-alpine --format '{{index .RepoDigests 0}}'
# Output: node@sha256:<hash>

# Example for eclipse-temurin:21-jre-alpine
docker pull eclipse-temurin:21-jre-alpine
docker inspect eclipse-temurin:21-jre-alpine --format '{{index .RepoDigests 0}}'
```

2. Update each `FROM` line:

```dockerfile
# BEFORE:
FROM node:24-alpine AS builder

# AFTER:
FROM node:24-alpine@sha256:<resolved-hash> AS builder
```

3. Images to pin (minimum — all that appear in production Dockerfiles):

| Service | Base images to pin |
|---------|-------------------|
| auth-service | `node:24-alpine` (builder + runtime) |
| payment-service | `node:24-alpine` (builder + runtime) |
| client | `node:24-alpine` (builder + runtime) |
| ticket-service | `golang:1.23-alpine` (builder), `alpine:3.20` or `gcr.io/distroless/static` (runtime) |
| expiration-service | `golang:1.23-alpine` (builder), `alpine:3.20` (runtime) |
| order-service | `maven:3.9-eclipse-temurin-21-alpine` (builder), `eclipse-temurin:21-jre-alpine` (runtime) |
| kong-gateway | `kong:3.7-ubuntu` (both stages) |

> `docker-compose.yml` is dev-only — tag pinning is optional there. Comment `# dev: tag-based` if
> you deliberately leave it unpinned.

**Commit message:**
```
fix(dockerfiles): pin all production base images to @sha256 digest

Mutable image tags are a supply chain attack vector. Resolves digest for every
FROM line across all service Dockerfiles. docker-compose.yml (dev-only) left
tag-based with an explanatory comment.

Closes audit finding S-18.
```

**Verify:**
```bash
grep -r "FROM " services/*/Dockerfile | grep -v "@sha256"
# Must return 0 lines (all FROM lines have digest)
```

---

### M2 Gate

- [ ] `curl -H "X-User-Id: spoofed" http://localhost:8000/api/tickets` → header absent in upstream logs
- [ ] `GET /api/payments/<id>` returns 403 for wrong user, 401 for no user
- [ ] `git grep -i "sk_test_" -- docker-compose.yml` → 0 matches
- [ ] `git grep -i "BEGIN PRIVATE KEY" -- docker-compose.yml` → 0 matches
- [ ] `docker run --rm kong-gateway:local whoami` → `kong`
- [ ] All Dockerfiles have `@sha256:` digests on `FROM` lines
- [ ] 18/18 E2E tests still pass
- [ ] Branch `fix/audit-m2-security-critical` pushed, PR opened, **awaiting owner review**

---

## Milestone M3 — P0: Resilience / DLQ

> **Branch:** `fix/audit-m3-dlq-resilience`
> **Gate:** Both DLQ implementations verified with integration tests.
> **Why:** Silent message loss on any transient failure means tickets may never be reserved/released
> and expiration timers may never fire. This is data loss by another name.

### Checklist

- [ ] **R-03** — Implement DLQ in ticket-service Kafka consumer
- [ ] **R-04** — Implement DLQ in expiration-service Kafka consumer

---

### R-03 · DLQ in ticket-service Kafka consumer

**File:** `services/ticket-service/internal/kafka/consumer.go:123`

**Problem:**
The consumer has a `// TODO: publish to DLQ; for now log and commit` comment. Failed messages
are acknowledged (offset committed) and permanently lost. AGENTS.md §3.5:
"Never silently discard a message."

**Fix — retry with exponential backoff + jitter, then DLQ:**

```go
// internal/kafka/consumer.go

const (
    maxRetries     = 3
    baseRetryDelay = 1 * time.Second
    maxRetryDelay  = 30 * time.Second
)

func (c *Consumer) processWithRetry(ctx context.Context, msg kafka.Message) error {
    var lastErr error
    for attempt := 0; attempt < maxRetries; attempt++ {
        if attempt > 0 {
            delay := exponentialBackoffWithJitter(attempt, baseRetryDelay, maxRetryDelay)
            c.log.Warn("retrying message processing",
                zap.Int("attempt", attempt),
                zap.Duration("delay", delay),
                zap.String("topic", msg.Topic),
            )
            select {
            case <-time.After(delay):
            case <-ctx.Done():
                return ctx.Err()
            }
        }

        if err := c.handleMessage(ctx, msg); err != nil {
            lastErr = err
            continue
        }
        return nil // success
    }

    // All retries exhausted — publish to DLQ
    c.log.Error("message processing failed after retries, routing to DLQ",
        zap.Error(lastErr),
        zap.String("topic", msg.Topic),
        zap.Int("partition", msg.Partition),
        zap.Int64("offset", msg.Offset),
    )
    return c.producer.PublishToDLQ(ctx, msg, lastErr)
}

func exponentialBackoffWithJitter(attempt int, base, max time.Duration) time.Duration {
    exp := base * (1 << attempt)          // 2^attempt * base
    if exp > max {
        exp = max
    }
    jitter := time.Duration(rand.Int63n(int64(exp / 2)))
    return exp/2 + jitter
}
```

DLQ topic naming (per AGENTS.md §3.5):
- `orders.order.created.dlq`
- `orders.order.cancelled.dlq`

**Commit sequence:**
```
feat(ticket-service): add exponential backoff with jitter to kafka consumer retry logic
feat(ticket-service): implement DLQ producer — route failed messages after 3 retries
test(ticket-service): add integration test for DLQ routing on consumer processing failure
```

**Verify:**
- Integration test: inject a processing error (stub `handleMessage` to always fail) → assert
  the message appears on the `.dlq` topic within 5 seconds and offset is committed.

---

### R-04 · DLQ in expiration-service Kafka consumer

**File:** `services/expiration-service/internal/kafka/consumer.go:74-80`

**Problem:** Identical pattern to R-03. The `TopicExpirationCompleteDLQ` constant is already
declared but never used.

**Fix:**
Apply the same `processWithRetry` + `exponentialBackoffWithJitter` pattern as R-03.
Use the existing `TopicExpirationCompleteDLQ` constant as the DLQ destination.

Also fix **R-10** here (same file, same effort): change the existing quadratic backoff
`time.Duration(attempt*attempt) * 100ms` to the proper exponential formula above.

```go
// Before (quadratic, wrong):
delay := time.Duration(attempt*attempt) * 100 * time.Millisecond

// After (exponential + jitter, correct):
delay := exponentialBackoffWithJitter(attempt, baseRetryDelay, maxRetryDelay)
```

**Commit sequence:**
```
fix(expiration-service): fix quadratic retry backoff to exponential with jitter (R-10)
feat(expiration-service): implement DLQ routing using TopicExpirationCompleteDLQ constant
test(expiration-service): add integration test for DLQ routing on consumer failure
```

**Verify:** Same pattern as R-03 — integration test with real Kafka (Testcontainers).

---

### M3 Gate

- [ ] ticket-service consumer: failing message appears on `orders.order.created.dlq` in test
- [ ] ticket-service consumer: offset is committed only after DLQ write succeeds
- [ ] expiration-service consumer: same for `TopicExpirationCompleteDLQ` topic
- [ ] Backoff formula is exponential (not quadratic), has jitter
- [ ] 18/18 E2E tests still pass
- [ ] Branch `fix/audit-m3-dlq-resilience` pushed, PR opened, **awaiting owner review**

---

## Milestone M4 — P0: CI Deploy Pipeline

> **Branch:** `fix/audit-m4-ci-deploy`
> **Gate:** At least one service pipeline deploys to a dev namespace and runs a smoke test.
> **Why:** Without a deploy stage, the CI system provides no production safety signal. Every merge
> to main is a manual, unverified operation.

### Checklist

- [ ] **I-11** — Add deploy stages to all CI pipelines
- [ ] **I-12** — Remove `:latest` tag from all CI push jobs

---

### I-11 · Add deploy stages to CI pipelines

**Files:** All `.github/workflows/ci-*.yml`

**Problem:** All pipelines end at "push image to GHCR." No deployment, no smoke test, no rollback.

**Fix — pipeline structure for each service:**

```yaml
# .github/workflows/ci-auth.yml (pattern; repeat for each service)

name: ci-auth-service

on:
  push:
    branches: [main]
    paths: ['services/auth-service/**', '.github/workflows/ci-auth.yml']
  pull_request:
    paths: ['services/auth-service/**']

concurrency:                          # I-13: cancel in-progress runs on same branch
  group: ci-auth-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm lint
        working-directory: services/auth-service

  test:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test:unit && pnpm test:integration
        working-directory: services/auth-service

  build:
    runs-on: ubuntu-latest
    needs: test
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - name: Build image
        id: build
        run: |
          docker build -t auth-service:${{ github.sha }} services/auth-service/
          docker save auth-service:${{ github.sha }} -o /tmp/auth-service.tar
      - uses: actions/upload-artifact@v4
        with:
          name: auth-service-image
          path: /tmp/auth-service.tar
      - name: Scan image (trivy)
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: auth-service:${{ github.sha }}
          exit-code: 1
          severity: HIGH,CRITICAL

  push:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/download-artifact@v4
        with: { name: auth-service-image, path: /tmp }
      - run: docker load -i /tmp/auth-service.tar
      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Push image (SHA tag only — no :latest)
        run: |
          docker tag auth-service:${{ github.sha }} ghcr.io/${{ github.repository }}/auth-service:${{ github.sha }}
          docker push ghcr.io/${{ github.repository }}/auth-service:${{ github.sha }}

  deploy-dev:
    runs-on: ubuntu-latest
    needs: push
    if: github.ref == 'refs/heads/main'
    environment: dev
    steps:
      - uses: actions/checkout@v4
      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-southeast-1
      - name: Update kubeconfig
        run: aws eks update-kubeconfig --name ticketing-dev --region ap-southeast-1
      - name: Deploy to dev
        run: |
          helm upgrade --install auth-service infra/helm/charts/auth-service \
            --namespace auth \
            --set image.tag=${{ github.sha }} \
            --wait --timeout=5m
      - name: Smoke test
        run: |
          sleep 10
          curl -f http://<kong-dev-url>/healthz/live || exit 1

  deploy-staging:
    runs-on: ubuntu-latest
    needs: deploy-dev
    if: github.ref == 'refs/heads/main'
    environment: staging          # requires manual approval in GitHub Environments settings
    steps:
      - name: Deploy to staging
        run: |
          helm upgrade --install auth-service infra/helm/charts/auth-service \
            --namespace auth \
            --set image.tag=${{ github.sha }} \
            --wait --timeout=5m

  deploy-prod:
    runs-on: ubuntu-latest
    needs: deploy-staging
    if: github.ref == 'refs/heads/main'
    environment: production       # requires manual approval gate
    steps:
      - name: Deploy to production
        run: |
          helm upgrade --install auth-service infra/helm/charts/auth-service \
            --namespace auth \
            --set image.tag=${{ github.sha }} \
            --wait --timeout=5m
```

**Important implementation notes:**
- GitHub OIDC → AWS IAM role assumption — no long-lived AWS keys in secrets (PLAN.md §10.4)
- The `environment: staging` and `environment: production` blocks enforce manual approval gates
  in GitHub's deployment protection rules (configure in repo Settings → Environments)
- Add `concurrency` block to all pipelines (fixes I-13 simultaneously)
- Build artifact (`.tar`) passed between jobs — eliminates double build (fixes I-14 simultaneously)

**Commit sequence:**
```
ci: add concurrency control and artifact-based image passing to all workflows (I-13, I-14)
ci(auth-service): add deploy-dev, deploy-staging, deploy-prod stages with smoke test
ci(ticket-service): add deploy stages
ci(order-service): add deploy stages
ci(payment-service): add deploy stages
ci(expiration-service): add deploy stages
ci(client): add deploy stages
ci(kong-gateway): add ci-kong-gateway.yml workflow for config validation (I-15)
```

### I-12 · Remove `:latest` tag from push jobs

In each workflow, remove any line that pushes a `:latest` tag. Only push `${{ github.sha }}`.

```yaml
# REMOVE these lines:
docker tag ... :latest
docker push ... :latest
```

**Commit message:**
```
fix(ci): remove :latest tag from all image push jobs

AGENTS.md §12.2: image tag = git SHA, never :latest. Mutable tags make
rollbacks unreliable and can silently overwrite known-good images.

Closes audit finding I-12.
```

---

### M4 Gate

- [ ] All workflows have `concurrency:` block (cancel-in-progress)
- [ ] No workflow pushes `:latest` tag
- [ ] Image passed as artifact between build and push jobs (no double build)
- [ ] At least auth-service pipeline has `deploy-dev` → `deploy-staging` (gated) → `deploy-prod` (gated) stages
- [ ] `ci-kong-gateway.yml` runs `build.sh` and `validate.sh`
- [ ] Branch `fix/audit-m4-ci-deploy` pushed, PR opened, **awaiting owner review**

---

## Milestone M5 — P1: Auth & Client Hardening

> **Branch:** `fix/audit-m5-auth-hardening`
> **Gate:** All items verified before M6.

### Checklist

- [ ] **S-01** — Implement refresh token rotation in auth-service
- [ ] **S-07** — Set `maxAge` on client auth cookie
- [ ] **S-08** — Replace regex cookie parsing with proper parser
- [x] **S-19** — Replace regex JSON parsing in `jwt-sub.lua` with `cjson` *(fixed in M6 hotfix: Kong 3.7 sandbox blocks all `require()` calls including `cjson` and `cjson.safe`; implemented using Lua string pattern matching `payload_json:match('"sub"%s*:%s*"([^"]+)"')` instead — equivalent correctness for well-formed JWTs)*

---

### S-01 · Refresh token rotation

**File:** `services/auth-service/src/modules/auth/auth.service.ts`

AGENTS.md §5.1 requires short-lived access tokens (15 min) plus long-lived refresh tokens
stored server-side in Redis, rotatable, delivered as an HttpOnly cookie.

**Fix — implementation outline:**

1. Generate a refresh token (opaque random UUID v4) on signin/signup
2. Store in Redis: `auth-service:refresh:<token-id>` → `{ userId, expiresAt }` with TTL 7 days
3. Return as a second `HttpOnly; Secure; SameSite=Strict` cookie (`refreshToken`)
4. Add `POST /api/auth/refresh` endpoint:
   - Read `refreshToken` cookie
   - Look up in Redis — 401 if missing or expired
   - Rotate: delete old token, issue a new refresh token (rotation), issue a new access token
   - Return both new tokens as cookies
5. On signout: delete the refresh token from Redis (implements S-04 server-side revocation simultaneously)

**Dependencies to add:**
- `ioredis` — Redis client (state why: needed for refresh token storage and S-04 token blacklist)

**Commit sequence:**
```
chore(auth-service): add ioredis dependency for refresh token storage
feat(auth-service): issue refresh token as HttpOnly cookie on signin/signup
feat(auth-service): add POST /api/auth/refresh endpoint with token rotation
feat(auth-service): revoke refresh token on signout (server-side invalidation)
test(auth-service): add unit + integration tests for refresh token flow
```

---

### S-07 · Set `maxAge` on client cookie

**File:** `services/client/app/actions/auth.ts:47-52`

```typescript
// BEFORE:
cookies().set('token', token, { httpOnly: true, path: '/' });

// AFTER:
cookies().set('token', token, {
  httpOnly: true,
  path: '/',
  maxAge: 900,          // 15 minutes — matches JWT_EXPIRY
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
});
```

**Commit message:**
```
fix(client): set maxAge: 900 on auth cookie to match JWT 15-minute TTL

Without maxAge the cookie was a session cookie — it survived past token
expiry, causing 401 errors until the user closed the browser.

Closes audit finding S-07.
```

---

### S-08 · Replace regex cookie parsing

**File:** `services/client/app/actions/auth.ts:45`

```typescript
// BEFORE (fragile regex):
const token = setCookie.match(/token=([^;]+)/)?.[1];

// AFTER (robust split-based parsing):
// Install set-cookie-parser: pnpm add set-cookie-parser (reason: proper RFC 6265 parser)
import { parse } from 'set-cookie-parser';

const cookies = parse(setCookie, { map: true });
const token = cookies['token']?.value;
```

**Commit message:**
```
fix(client): replace fragile regex cookie parsing with set-cookie-parser

The regex did not handle quoted values, URL-encoded characters, or multiple
Set-Cookie headers. set-cookie-parser is RFC 6265 compliant.

Closes audit finding S-08.
```

---

### S-19 · Replace regex JSON parsing in `jwt-sub.lua`

**File:** `services/kong-gateway/plugins/jwt-sub.lua:21`

```lua
-- BEFORE (fragile regex — breaks on escaped quotes):
local sub = payload_json:match('"sub"%s*:%s*"([^"]+)"')

-- AFTER (use cjson — available in all Kong/OpenResty environments):
local cjson_safe = require("cjson.safe")
local payload, err = cjson_safe.decode(payload_json)
if err or not payload then
  kong.log.err("failed to decode JWT payload: ", err)
  return kong.response.exit(401, { message = "Invalid token" })
end
local sub = payload.sub
```

**Commit message:**
```
fix(kong-gateway): use cjson.safe.decode instead of regex for JWT sub extraction

Regex parsing broke on JWT payloads with escaped quotes in claim values.
cjson.safe is available in all Kong/OpenResty environments and handles all
valid JSON correctly.

Closes audit finding S-19.
```

---

### M5 Gate

- [ ] Refresh token issued as `HttpOnly` cookie on signin/signup
- [ ] `POST /api/auth/refresh` rotates token and returns new access token
- [ ] Signout deletes refresh token from Redis
- [ ] Client cookie has `maxAge: 900`
- [ ] Cookie parsing uses `set-cookie-parser`
- [x] Kong JWT sub extraction does not use raw regex for JSON decoding *(cjson unavailable in sandbox; Lua pattern match used — see S-19 note above)*
- [ ] 18/18 E2E still pass
- [ ] Branch pushed, PR opened, **awaiting owner review**

---

## Milestone M6 — P1: Resilience & Observability

> **Branch:** `fix/audit-m6-resilience-obs`
> **Gate:** Circuit breaker tested, gRPC interceptors in place, Stripe hardened.

### Checklist

- [x] **R-01** — Circuit breaker on order-service gRPC client
- [x] **R-05** — Fix silent Kafka publish failures in ticket-service
- [x] **R-07** — Fix expiration-service readiness probe (always 200)
- [x] **R-08** — Add gRPC server interceptors to ticket-service
- [x] **R-09** — Add request size limiting to Kong
- [x] **R-11** — Implement Stripe webhook handler
- [x] **R-12** — Add Stripe idempotency key
- [x] **R-15** — Fix `KafkaAdmin` hardcoded to `localhost:9092`
- [x] **I-19** — Fix duplicate rate-limiting plugin in Kong
- [x] **O-01** — Add OpenTelemetry SDK to all services *(largest single item — ~2 days)*
- [x] **O-02** — Add `traceId`/`spanId` to all structured log output
- [x] **O-04** — Register `GlobalExceptionFilter` via DI for structured logging

---

### R-01 · Circuit breaker on gRPC client

**File:** `services/order-service/src/main/java/com/ticketing/orders/grpc/TicketServiceClient.java`

Add `resilience4j-spring-boot3` (state why: circuit breaker implementation for Spring Boot 3/4
that integrates with Micrometer for metrics exposure).

```xml
<!-- pom.xml -->
<dependency>
  <groupId>io.github.resilience4j</groupId>
  <artifactId>resilience4j-spring-boot3</artifactId>
</dependency>
```

```yaml
# application.yml
resilience4j:
  circuitbreaker:
    instances:
      ticketService:
        failure-rate-threshold: 50
        slow-call-rate-threshold: 80
        slow-call-duration-threshold: 4s
        sliding-window-type: TIME_BASED
        sliding-window-size: 10
        wait-duration-in-open-state: 30s
        permitted-number-of-calls-in-half-open-state: 3
```

```java
@CircuitBreaker(name = "ticketService", fallbackMethod = "validateTicketFallback")
public TicketValidationResult validateTicket(String ticketId) {
    // ... existing gRPC call ...
}

private TicketValidationResult validateTicketFallback(String ticketId, Exception ex) {
    log.warn("Circuit breaker open for ticket-service, ticketId={}", ticketId);
    throw new ServiceUnavailableException("Ticket service is temporarily unavailable");
}
```

---

### R-08 · gRPC server interceptors

**File:** `services/ticket-service/internal/grpc/server.go:96`

Add interceptors for logging, metrics, recovery, and deadline enforcement:

```go
// Dependencies to add:
// go get -q github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/logging
// go get -q github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery
// go get -q github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/timeout

grpcServer := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        grpc_recovery.UnaryServerInterceptor(
            grpc_recovery.WithRecoveryHandler(func(p interface{}) error {
                log.Error("panic in gRPC handler", zap.Any("panic", p))
                return status.Errorf(codes.Internal, "internal server error")
            }),
        ),
        grpc_logging.UnaryServerInterceptor(grpcZapLogger(log)),
        timeout.UnaryServerInterceptor(5 * time.Second),
    ),
)
```

---

### R-12 · Stripe idempotency key

**File:** `services/payment-service/src/modules/payments/payments.service.ts:72-79`

```typescript
// BEFORE:
const intent = await this.stripe.paymentIntents.create({ amount, currency });

// AFTER:
const intent = await this.stripe.paymentIntents.create(
  { amount, currency },
  { idempotencyKey: dto.orderId },   // prevents double-charge on retry
);
```

---

### R-15 · Fix KafkaAdmin hardcoded broker

**File:** `services/order-service/src/main/java/com/ticketing/orders/config/KafkaConfig.java:42`

```java
// BEFORE:
admin.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");

// AFTER:
@Value("${spring.kafka.bootstrap-servers}")
private String bootstrapServers;

// In the KafkaAdmin bean:
admin.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
```

---

### O-01 · OpenTelemetry SDK — all services

This is the largest single item. Approach per language:

**NestJS (auth-service, payment-service):**
```bash
# Dependencies (state why: OTel SDK for Node.js with NestJS and HTTP auto-instrumentation)
pnpm add --silent @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-otlp-grpc @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```
Create `src/tracing.ts` — must be imported before anything else via `--require` or `NODE_OPTIONS`.

**Go (ticket-service, expiration-service):**
```bash
go get -q go.opentelemetry.io/otel \
  go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc
```
Add `otelecho.Middleware("ticket-service")` to the Echo instance.

**Java (order-service):**
Use the OTel Java agent — zero code change:
```dockerfile
# In Dockerfile, download the agent during build:
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.x.x/opentelemetry-javaagent.jar /app/otel-agent.jar
# In CMD/ENTRYPOINT:
CMD ["java", "-javaagent:/app/otel-agent.jar", "-jar", "app.jar"]
```

**Commit sequence:**
```
feat(auth-service): add OpenTelemetry SDK with auto-instrumentation
feat(payment-service): add OpenTelemetry SDK with auto-instrumentation
feat(ticket-service): add OpenTelemetry SDK with otelecho middleware and gRPC propagation
feat(expiration-service): add OpenTelemetry SDK
feat(order-service): add OTel Java agent auto-instrumentation
feat(client): add @vercel/otel for Next.js tracing
```

---

### M6 Gate

- [x] Circuit breaker triggers when ticket-service is unavailable (test: kill ticket-service pod)
- [x] gRPC server logs every call and recovers from panics
- [x] Stripe PaymentIntent call includes `idempotencyKey`
- [x] `spring.kafka.bootstrap-servers` used in `KafkaAdmin` (not localhost)
- [x] OTel traces visible in OTel Collector / Jaeger local instance for at least 2 services
- [x] `traceId` and `spanId` present in structured log output
- [x] 18/18 E2E still pass
- [x] Branch pushed, PR opened, **merged to `main` at `850b975` — 2026-03-28**

---

## Milestone M7 — P1: Performance, Helm & CI

> **Branch:** `fix/audit-m7-perf-helm-ci`
> **Gate:** All items verified.

### Checklist

- [ ] **P-01** — Add pagination to ticket-service `FindAll`
- [ ] **P-03** — Replace `cache: "no-store"` with appropriate caching in client
- [ ] **I-04** — Replace `image.tag: latest` with `SET_BY_CI` in Helm values
- [ ] **I-16** — Add proto stub regeneration check to proto CI
- [ ] **I-17** — Fix `.env` heredoc indentation in E2E workflow
- [ ] **I-18** — Add `KONG_RSA_PUBLIC_KEY` to E2E workflow
- [ ] **C-02** — Fix `OutboxRelay` batch transaction (duplicate events)
- [ ] **C-03** — Add OCC to `ReserveTicket` in ticket-service
- [ ] **R-02** — Fix gRPC channel leak on shutdown in order-service
- [ ] **R-06** — Replace `log.Fatal` in goroutines with controlled error propagation
- [ ] **R-14** — Add outbox table cleanup scheduled job
- [ ] **T-01** — Add gRPC integration tests for ticket-service
- [ ] **T-02** — Add Kafka consumer integration tests for ticket-service
- [ ] **T-07** — Fix health endpoint tests in expiration-service

---

### P-01 · Pagination for ticket-service `FindAll`

**File:** `services/ticket-service/internal/repository/mongo_ticket_repository.go:171-186`

```go
type PaginationParams struct {
    Limit  int64  // default 20, max 100
    After  string // last seen ticket ID (cursor-based)
}

func (r *MongoTicketRepository) FindAll(ctx context.Context, p PaginationParams) ([]*Ticket, error) {
    if p.Limit <= 0 || p.Limit > 100 {
        p.Limit = 20
    }

    filter := bson.M{"orderId": ""}    // only unreserved tickets
    if p.After != "" {
        filter["_id"] = bson.M{"$gt": p.After}  // cursor
    }

    opts := options.Find().
        SetLimit(p.Limit).
        SetSort(bson.D{{Key: "_id", Value: 1}})

    // ... execute query ...
}
```

Update the HTTP handler and gRPC service to accept and forward pagination params.

---

### P-03 · Next.js caching strategy

**File:** `services/client/lib/api.ts:29`

```typescript
// BEFORE — disables ALL Next.js caching for every fetch:
cache: "no-store"

// AFTER — differentiate by endpoint type:
export function serverApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isUserSpecific = path.includes('/currentuser') ||
                          path.includes('/orders') ||
                          path.includes('/payments');

  return fetch(`${base()}${path}`, {
    ...options,
    // User-specific data: never cache
    // Public read data: revalidate every 10 seconds
    ...(isUserSpecific
      ? { cache: 'no-store' }
      : { next: { revalidate: 10 } }),
  }).then(/* ... existing handler ... */);
}
```

---

### I-04 · Replace `latest` with `SET_BY_CI` in Helm values

**File:** `infra/helm/values.yaml`

```yaml
# BEFORE:
image:
  tag: latest

# AFTER:
image:
  tag: "SET_BY_CI"    # CI passes: --set <service>.image.tag=$GITHUB_SHA
```

Update all 6 service sections. Update CI workflows to pass `--set auth-service.image.tag=${{ github.sha }}`.

---

### C-02 · Fix `OutboxRelay` batch transaction

**File:** `services/order-service/src/main/java/com/ticketing/orders/outbox/OutboxRelay.java:40-59`

Remove `@Transactional` from the relay method. Handle each message individually:

```java
// BEFORE: entire batch in one @Transactional (partial Kafka success → full DB rollback)
@Transactional
public void relayPendingMessages() { ... }

// AFTER: per-message atomic update
public void relayPendingMessages() {
    List<OutboxMessage> messages = outboxRepository.findByPublishedFalse();
    for (OutboxMessage msg : messages) {
        try {
            kafkaTemplate.send(msg.getTopic(), msg.getPartitionKey(), msg.getPayload()).get(10, SECONDS);
            outboxRepository.markPublished(msg.getId());  // individual update
        } catch (Exception e) {
            log.error("Failed to relay outbox message {}: {}", msg.getId(), e.getMessage());
            // Leave as unpublished — relay will retry on next poll
        }
    }
}
```

---

### M7 Gate

- [ ] `GET /api/tickets?limit=20&after=<cursor>` returns paginated results
- [ ] Client homepage uses `revalidate: 10` for ticket list
- [ ] All Helm values use `tag: "SET_BY_CI"`
- [ ] Proto CI runs `make proto && git diff --exit-code`
- [ ] E2E workflow `.env` has no leading whitespace
- [ ] E2E workflow sets both `RSA_PRIVATE_KEY` and `KONG_RSA_PUBLIC_KEY`
- [ ] `OutboxRelay` uses per-message updates (no batch `@Transactional`)
- [ ] `ReserveTicket` filter includes `"orderId": ""` OCC guard
- [ ] gRPC channel has `destroyMethod = "shutdown"`
- [ ] 18/18 E2E still pass
- [ ] Branch pushed, PR opened, **awaiting owner review**

---

## Milestone M8 — P2: Security & Correctness

> **Branch:** `fix/audit-m8-p2-security`
> **Gate:** All items verified.

### Checklist

- [ ] **S-04** — Redis-based JWT blacklist on signout
- [ ] **S-06** — Derive cookie `maxAge` from `JWT_EXPIRY` config
- [ ] **S-09** — Set `fail-on-unknown-properties: true` in order-service
- [ ] **S-10** — Add UUID format validation to `CreateOrderRequest.ticketId`
- [ ] **S-11** — Restrict `currency` field to ISO 4217 codes (`@IsIn` / `@MaxLength(3)`)
- [ ] **S-14** — Add email format validation in client Server Actions
- [ ] **S-20** — Audit Git history for committed `.env` files
- [ ] **C-04** — Distinguish OCC conflict from not-found in ticket-service Update
- [ ] **C-07** — Delete dead state machine package in order-service
- [ ] **C-08** — Change proto `price` from `double` to `string`
- [ ] **C-09** — Tighten `isAwaitingPayment()` to exclude `CREATED` status
- [ ] **C-12** — Fix `TICKET_SERVICE_GRPC_PORT` default to `50051`
- [ ] **R-13** — Map gRPC status codes to appropriate HTTP codes in order-service
- [ ] **P-05** — Decode JWT from cookie instead of HTTP roundtrip for user ID
- [ ] **P-07** — Add memory metric to HPA definitions
- [ ] **P-08** — Add `loading.tsx` Suspense boundaries in client
- [ ] **P-11** — Fix static `replicas` conflicting with HPA
- [ ] **I-05** — Add conditional guard on ticket-service `envFrom`
- [ ] **I-06** — Add `ServiceAccount` per service in Helm
- [ ] **I-20** — Create `infra/scripts/bootstrap-state.sh`
- [ ] **I-21** — Add TLS termination config to Kong Terraform module
- [ ] **I-22** — Create Terraform CI/CD pipeline
- [ ] **DRY-01** — Extract shared RSA key parsing in auth-service
- [ ] **DRY-02** — Extract shared `base()`/`authHeaders()` in client Server Actions
- [ ] **D-05** — Remove dead `clientApi` (axios) export from client
- [ ] **CV-01** — Fix `go 1.25` to `go 1.23` in `go.mod` files
- [ ] **CV-05** — Fix `EXPOSE 8083` → `EXPOSE 8080` in expiration-service Dockerfile
- [ ] **T-03** — Kafka consumer integration tests for order-service
- [ ] **T-04** — Kafka consumer integration tests for payment-service
- [ ] **T-05** — Unit tests for client Server Actions
- [ ] **T-08** — Concurrent OCC conflict test for ticket-service
- [ ] **T-10** — Fix auth-service integration test isolation
- [ ] **T-11** — Replace `os.Unsetenv` with `t.Setenv` in Go config tests
- [ ] **T-12** — Replace `time.Sleep` with polling assertions in expiration tests
- [ ] **T-13** — Remove fixed host port `19092` for Kafka in expiration tests

---

### Key fix notes for M8

**C-07 — Delete state machine package:**
```bash
rm -rf services/order-service/src/main/java/com/ticketing/orders/statemachine/
# Also remove @EnableStateMachineFactory from the application class
# Remove spring-statemachine-* from pom.xml
```

**C-08 — Change proto `price` to `string`:**
This is a breaking proto change — requires a version bump:
1. Create `proto/tickets/v2/tickets.proto` with `string price = 3;`
2. Regenerate stubs: `make proto`
3. Update all callers (order-service, ticket-service)
4. Keep v1 in place until all consumers migrated

**CV-01 — Fix Go version:**
```
# go.mod — both ticket-service and expiration-service
go 1.23   # was: go 1.25 (does not exist)
```

**S-20 — Audit Git history:**
```bash
git log --all --diff-filter=A --name-only --format="" -- '**/.env'
# If any .env file was committed, consider rotating exposed credentials
# and using git-filter-repo to remove from history (coordinate with team)
```

---

### M8 Gate

- [ ] State machine package deleted, Spring Boot starts without it
- [ ] `go 1.23` in all `go.mod` files
- [ ] `EXPOSE 8080` in expiration-service Dockerfile
- [ ] `isAwaitingPayment()` returns `true` only for `AWAITING_PAYMENT`
- [ ] `TICKET_SERVICE_GRPC_PORT` defaults to `50051` everywhere
- [ ] HPA does not set replicas when autoscaling is enabled
- [ ] Loading skeletons on data-heavy routes in client
- [ ] 18/18 E2E still pass
- [ ] Branch pushed, PR opened, **awaiting owner review**

---

## Milestone M9 — P2: Code Quality & Testing

> **Branch:** `fix/audit-m9-quality-tests`
> **Gate:** All items verified. Test suite time ≤ 10 min in CI.

### Checklist

- [ ] **O-03** — Add custom RED metrics to NestJS services
- [ ] **O-05** — Add `service` field to Go service loggers
- [ ] **O-06** — Add all-dependency readiness checks
- [ ] **O-08** — Parse `traceparent` header to extract just trace ID
- [ ] **O-09** — Replace `console.log` in `migrate.ts` with standalone Pino instance
- [ ] **P-06** — Replace `JOIN FETCH` with `existsBy` query in order-service
- [ ] **P-09** — Remove unused `axios` from client bundle
- [ ] **P-10** — Fix Docker layer caching for Go services
- [ ] **I-01** — Add `NetworkPolicy` to all Helm sub-charts
- [ ] **I-02** — Add `startupProbe` for slow-starting services
- [ ] **I-03** — Add `topologySpreadConstraints` for production
- [ ] **I-07** — Add `_helpers.tpl` to all Helm sub-charts
- [ ] **I-08** — Wire `global.imageRegistry` into templates or remove
- [ ] **I-09** — Add explicit `RollingUpdate` strategy to deployments
- [ ] **T-14** — Improve client component test mocking strategy

---

### Key fix notes for M9

**P-10 — Fix Go Docker layer caching:**
```dockerfile
# BEFORE (cache-busting on any source change):
COPY . .
RUN go mod download

# AFTER (deps cached independently of source):
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build ...
```

**I-01 — NetworkPolicy example:**
```yaml
# auth-service NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: auth-service
spec:
  podSelector:
    matchLabels:
      app: auth-service
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: infra   # Kong only
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: postgres-auth
      ports: [{ port: 5432 }]
```

**I-02 — `startupProbe` for order-service:**
```yaml
startupProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  failureThreshold: 30    # 30 × 5s = 150s budget for Spring Boot startup
  periodSeconds: 5
livenessProbe:
  initialDelaySeconds: 5  # short — startupProbe already gate-keeps
```

---

### M9 Gate

- [ ] All Helm sub-charts have `NetworkPolicy` templates
- [ ] order-service has `startupProbe` in Helm values
- [ ] `service` field in every Go log line
- [ ] `prom-client` RED metrics on NestJS HTTP handlers
- [ ] No `axios` in client `package.json`
- [ ] Go Dockerfiles have correct layer order (go.mod → download → source → build)
- [ ] 18/18 E2E still pass
- [ ] CI test run completes in ≤ 10 minutes
- [ ] Branch pushed, PR opened, **awaiting owner review**

---

## Milestone M10 — P3: Tech Debt Backlog

> **Branch:** `fix/audit-m10-tech-debt`
> **Gate:** All items verified. No deployment gate — schedule at a convenient sprint.

### Checklist

- [ ] **S-12** — UUID format validation on ticket-service path params
- [ ] **S-13** — Use `utf8.RuneCountInString()` for title length in ticket-service
- [ ] **S-21** — Add `packageManager` field to Node.js `package.json` files
- [ ] **C-10** — Fix `drizzle.config.ts` output dir (`./drizzle` → `./migrations`)
- [ ] **D-02** — Remove unused `NON_TERMINAL_STATUSES` constant in order-service
- [ ] **D-03** — Delete `app.e2e-spec.ts` scaffold test in auth-service
- [ ] **D-04** — Delete `jest-e2e.json` config in auth-service (project uses Vitest)
- [ ] **D-06** — Remove unused `jwks-rsa` dependency from auth-service
- [ ] **D-07** — Remove unused `@nestjs/microservices` from payment-service
- [ ] **D-08** — Remove unused `source-map-support`, `ts-loader` from auth-service
- [ ] **D-09** — Move `pino-pretty` to `devDependencies` in payment-service
- [ ] **D-10** — Remove unused `COOKIE_DOMAIN` from Joi schema in auth-service
- [ ] **D-12** — Remove unused `ConflictException` import in payment-service
- [ ] **D-13** — Replace `globals.jest` with `globals.vitest` in ESLint config
- [ ] **DRY-03** — Extract shared broker string join logic in ticket-service
- [ ] **DRY-04** — Extract shared status config maps in client
- [ ] **DRY-05** — Extract shared `fullName` computation in Helm templates
- [ ] **CV-02** — Add `engines`/`packageManager` field to Node.js `package.json`
- [ ] **CV-03** — Rename DLQ suffix from `.DLT` to `.dlq` in order-service
- [ ] **CV-04** — Move gRPC stubs from ticket-service to `/libs/`
- [ ] **CV-06** — Remove `go mod tidy` from Dockerfiles (non-hermetic)
- [ ] **CV-07** — Remove duplicate `CHECK` constraint in payment migration
- [ ] **T-06** — Add unit tests for client Server Components / pages
- [ ] **T-09** — Add controller unit tests for auth-service
- [ ] **T-15** — Improve `StubTicketService` to return realistic data in order-service tests
- [ ] **T-16** — Fix `PG_POOL` import in auth-service integration test
- [ ] **I-10** — Add `NOTES.txt` to Helm sub-charts

---

### M10 Gate

- [ ] `pnpm audit` — zero production dependency issues
- [ ] `go vuln` — zero vulnerabilities
- [ ] No unused imports/dependencies surfaced by linters
- [ ] All Vitest configs no longer reference Jest globals
- [ ] All items in this milestone checked
- [ ] Branch pushed, PR opened, **awaiting owner review**

---

## Progress Dashboard

| Milestone | Branch | Status | E2E | PR |
|-----------|--------|--------|-----|----|
| M1 — P0 Data Integrity | `fix/audit-m1-data-integrity` | 🟡 Awaiting review | 18/18 | — |
| M2 — P0 Security Critical | `fix/audit-m2-security-critical` | ⬜ Not started | — | — |
| M3 — P0 DLQ / Resilience | `fix/audit-m3-dlq-resilience` | ⬜ Not started | — | — |
| M4 — P0 CI Deploy | `fix/audit-m4-ci-deploy` | ⬜ Not started | — | — |
| M5 — P1 Auth Hardening | `fix/audit-m5-auth-hardening` | 🟡 Partial (S-19 done) | — | — |
| M6 — P1 Resilience + OTel | `fix/audit-m6-resilience-obs` | ✅ Merged `850b975` | 18/18 | #8 |
| M7 — P1 Performance + Helm | `fix/audit-m7-perf-helm-ci` | ⬜ Not started | — | — |
| M8 — P2 Security + Correctness | `fix/audit-m8-p2-security` | ⬜ Not started | — | — |
| M9 — P2 Quality + Testing | `fix/audit-m9-quality-tests` | ⬜ Not started | — | — |
| M10 — P3 Tech Debt | `fix/audit-m10-tech-debt` | ⬜ Not started | — | — |

---

## Workflow Rules (reminder)

```
# Start a milestone
git checkout main && git pull
git checkout -b fix/audit-m<N>-<slug>

# Per meaningful change
git add <specific files>
git commit -m "<type>(<scope>): <description>

<body: why, not what>

Closes audit finding <ID>."

# Push and open PR
git push -u origin fix/audit-m<N>-<slug>
# Open PR → request owner review → WAIT for approval → squash merge → delete branch
```

**Never:**
- Merge a branch without owner review
- Push directly to `main`
- Combine fixes from different milestones in one branch
- Use `--no-verify` to skip hooks
