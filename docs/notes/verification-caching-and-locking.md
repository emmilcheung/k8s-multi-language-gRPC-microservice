# Verification Guide — Caching & Locking (`feat/caching-and-locking`)

> How to prove this change is correct before merging to `main`.
> Covers every test layer: unit → integration → API smoke → regression → Kubernetes E2E.

---

## 0. What Was Changed (summary)

| Area | Change |
|---|---|
| **Kong** | Three-tier rate limiting: anonymous IP / authenticated consumer / auth-endpoint route |
| **ticket-service** (Go) | Redis query cache via cache-aside decorator; `NoopCache` fallback when `REDIS_URL` unset |
| **order-service** (Java) | Redisson distributed lock on `createOrder`; 409 on contention; 503 on Redis outage |
| **Infrastructure** | `REDIS_URL` added to Docker Compose + Helm values; Kong `redis_host` vars added |

---

## 1. Prerequisites

```bash
# All commands assume repo root unless otherwise stated.
# Docker must be running. minikube section requires minikube running.

# Confirm staged changes cover only the expected files:
git status --short

# Check you are on the correct branch (should be main with staged changes,
# or feat/caching-and-locking if the branch was already created):
git branch --show-current
```

---

## 2. Unit Tests

### 2.1 ticket-service — Redis cache unit tests (miniredis, no Docker)

```bash
cd services/ticket-service
go test ./internal/cache/... -v -count=1
```

**Expected:** 7 tests pass, all in < 2 s.

| Test | What it verifies |
|---|---|
| `TestRedisCache_GetTicket_CacheMiss` | Returns `nil, nil` on a cold cache key |
| `TestRedisCache_GetTicket_CacheHit` | Deserialises a stored ticket correctly |
| `TestRedisCache_SetTicket` | `GetTicket` after `SetTicket` returns same struct |
| `TestRedisCache_GetList_Miss` | Returns `nil, nil` when list key absent |
| `TestRedisCache_GetList_Hit` | Deserialises a stored ticket slice correctly |
| `TestRedisCache_SetList` | `GetList` after `SetList` returns same slice |
| `TestRedisCache_InvalidateTicket` | Key is absent from Redis after invalidation |

### 2.2 ticket-service — config tests

```bash
go test ./internal/config/... -v -count=1
```

**Expected:** 3 tests pass (including `TestLoad_RedisURLOptional` and `TestLoad_Defaults`).

### 2.3 ticket-service — service layer (unchanged, regression check)

```bash
go test ./internal/service/... -v -count=1
```

**Expected:** all 10 pre-existing tests pass unchanged — the service layer has no Redis awareness.

### 2.4 order-service — unit tests (mocked Redisson)

```bash
cd services/order-service
mvn -Dtest=OrderServiceTest test -q
```

**Expected:** all tests pass, including the 5 new lock-specific ones:

| Test | What it verifies |
|---|---|
| `createOrder_acquires_and_releases_lock` | `lock.tryLock(0,5,SECONDS)` called; `lock.unlock()` called in finally |
| `createOrder_throws_ConflictException_when_lock_not_acquired` | 409 path when `tryLock` returns `false` |
| `createOrder_releases_lock_on_exception` | `unlock()` called even when downstream throws |
| `createOrder_throws_ServiceUnavailableException_when_redis_down` | 503 path when `getMultiLock` throws `RedisException` |
| `createOrder_lock_key_includes_ticket_id` | Lock key is `order-service:lock:ticket:{ticketId}` |

---

## 3. Integration Tests

### 3.1 ticket-service — cache integration (real MongoDB + real Redis via Testcontainers)

Requires Docker socket access. Allow up to 3 minutes for container pulls on first run.

```bash
cd services/ticket-service
go test ./test/... -run TestCaching -v -timeout 180s -count=1
```

**Expected:** 9 tests pass:

| Test | What it verifies |
|---|---|
| `TestCaching_GetTicket_CacheHit` | Second read served from Redis, not MongoDB (call count = 1) |
| `TestCaching_GetTicket_CacheMiss_ThenPopulates` | Cold read populates cache; warm read skips DB |
| `TestCaching_GetAllTickets_CacheHit` | List is cached; second call skips DB |
| `TestCaching_CreateTicket_InvalidatesList` | Write clears list cache; next list read hits DB |
| `TestCaching_UpdateTicket_InvalidatesTicketAndList` | Update clears both ticket + list keys |
| `TestCaching_DeleteTicket_InvalidatesTicketAndList` | Delete clears both keys |
| `TestCaching_ReserveTicket_InvalidatesTicket` | Reserve clears ticket key |
| `TestCaching_ReleaseTicket_InvalidatesTicket` | Release clears ticket key |
| `TestCaching_RedisFailure_FallsThrough` | `failingCache` errors are swallowed; DB is queried normally |

### 3.2 ticket-service — existing HTTP integration (regression)

```bash
cd services/ticket-service
go test ./test/... -run TestTicket -v -timeout 180s -count=1
```

**Expected:** all 13 pre-existing HTTP integration tests pass unchanged.

### 3.3 order-service — integration tests (real PostgreSQL + MongoDB + Redis + gRPC via Testcontainers)

```bash
cd services/order-service
mvn verify -Dit.test=OrderIntegrationTest -q
```

**Expected:** all integration tests pass, including the new concurrency test:

| Test | What it verifies |
|---|---|
| `createOrder_returns_409_or_400_when_concurrent_requests_for_same_ticket` | 10 concurrent requests for the same ticket; exactly 1 succeeds (201), rest get 409 or 400 |
| `createOrder_returns_201_and_order_body` | Status field is `"created"` (lowercase) — regression-corrected assertion |
| `cancelOrder_returns_cancelled_order` | Status field is `"cancelled"` (lowercase) — regression-corrected assertion |

> **Note on status case:** The two pre-existing assertions were corrected from `"CREATED"`/`"CANCELLED"` to lowercase. This reflects actual Jackson serialisation behaviour (enum `.name().toLowerCase()`). This is a test bug fix, not a service behaviour change.

---

## 4. Kong Rate-Limit Smoke Tests (Docker Compose)

Start the full stack first:

```bash
docker compose up -d --build
# Wait ~30 s for all services to be healthy
docker compose ps
```

### 4.1 Confirm Kong config loaded correctly

```bash
# Kong admin API (exposed on :8001 in docker-compose)
curl -s http://localhost:8001/plugins | jq '[.data[] | {name, config: {limit_by: .config.limit_by, minute: .config.minute, policy: .config.policy}}]'
```

**Expected:** 3 rate-limiting plugin entries visible:
1. Global anonymous — `limit_by: ip`, `minute: 300` (local values file)
2. Global authenticated — `limit_by: consumer`, `minute: 300`
3. Route `auth-public` — `minute: 30`

### 4.2 Anonymous IP rate limit

The local limit is 300 req/min. Trigger it quickly with `ab` or a simple loop:

```bash
# Send 35 rapid requests to the auth signup endpoint (unauthenticated)
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:8000/v1/auth/signup \
    -H "Content-Type: application/json" \
    -d '{"email":"x@x.com","password":"pass123"}'; 
done
```

The first 30 will return `400` or `201` (business logic). Request 31+ should return `429`.

> **Tip:** If 300/min is too high to trigger manually, temporarily edit `values/local.yml` → `rateLimit.authEndpointsPerMinute: 3`, rebuild with `bash services/kong-gateway/scripts/build.sh local && docker compose restart kong`, then repeat.

### 4.3 Rate-limit response headers

```bash
curl -si -X POST http://localhost:8000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"a@b.com","password":"pass123"}' | grep -i x-ratelimit
```

**Expected headers present:**
```
X-RateLimit-Limit-Minute: 30
X-RateLimit-Remaining-Minute: 29
```

### 4.4 Verify Redis is being used for rate-limit counters (staging/prod policy)

In local/dev, `policy: local` is used (Kong memory) — Redis is not exercised for rate-limiting locally. To test the `redis` policy path:

```bash
# Temporarily override in local.yml:
#   rateLimit.policy: redis
#   rateLimit.redisHost: redis
#   rateLimit.redisPort: "6379"
# Rebuild Kong config and restart. Then:

redis-cli -p 6379 --scan --pattern 'kong*'
# After sending requests, Kong rate-limit keys should appear.
```

---

## 5. ticket-service Cache Smoke Tests (Docker Compose)

### 5.1 Confirm cache is wired

```bash
# Ticket service logs should show Redis connection on startup (no error):
docker compose logs ticket-service | grep -i redis
```

**Expected:** a log line like `connected to Redis` or no Redis error lines.

### 5.2 Cache hit/miss via Redis CLI

```bash
# Open a redis-cli session:
docker compose exec redis redis-cli

# In redis-cli:
KEYS ticket-service:*
# Initially empty.

# Create a ticket via Kong:
# (in a separate terminal)
TOKEN=$(curl -s -X POST http://localhost:8000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"cache@test.com","password":"password123"}' | jq -r '.token')

curl -s -X POST http://localhost:8000/v1/tickets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Cache Test","price":42}'

# Back in redis-cli:
KEYS ticket-service:*
# Expected: ticket-service:tickets:list (list cache populated on next GET)

# Fetch tickets:
curl -s http://localhost:8000/v1/tickets -H "Authorization: Bearer $TOKEN"

# In redis-cli:
KEYS ticket-service:*
# Expected: ticket-service:tickets:list  (now populated)
TTL ticket-service:tickets:list
# Expected: ~30 (seconds remaining)
```

### 5.3 Cache invalidation on update

```bash
# Get a ticket ID from the previous list response, then update:
TICKET_ID=<id from previous response>

curl -s -X PUT http://localhost:8000/v1/tickets/$TICKET_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Updated","price":99}'

# In redis-cli:
KEYS ticket-service:ticket:$TICKET_ID
# Expected: (empty) — key was invalidated
KEYS ticket-service:tickets:list
# Expected: (empty) — list was invalidated
```

### 5.4 Cache fallthrough when Redis is down

```bash
# Stop Redis:
docker compose stop redis

# Fetch tickets — should still work (falls through to MongoDB):
curl -s http://localhost:8000/v1/tickets -H "Authorization: Bearer $TOKEN"
# Expected: 200 with ticket list (no 500)

# ticket-service logs should show a WARN (not ERROR/FATAL) for Redis:
docker compose logs ticket-service | tail -20

# Restart Redis:
docker compose start redis
```

---

## 6. order-service Lock Smoke Tests (Docker Compose)

### 6.1 Normal order creation (lock acquired and released)

```bash
# Sign up two users:
BUYER=$(curl -s -X POST http://localhost:8000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@test.com","password":"password123"}' | jq -r '.token')

SELLER=$(curl -s -X POST http://localhost:8000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"seller@test.com","password":"password123"}' | jq -r '.token')

# Create a ticket as seller:
TICKET=$(curl -s -X POST http://localhost:8000/v1/tickets \
  -H "Authorization: Bearer $SELLER" \
  -H "Content-Type: application/json" \
  -d '{"title":"Lock Test","price":50}')
TICKET_ID=$(echo $TICKET | jq -r '.id')

# Place an order as buyer:
curl -s -X POST http://localhost:8000/v1/orders \
  -H "Authorization: Bearer $BUYER" \
  -H "Content-Type: application/json" \
  -d "{\"ticketId\":\"$TICKET_ID\"}"
# Expected: 201 with order body, status "created"
```

### 6.2 Concurrent requests — 409 on contention

```bash
# Use GNU parallel or background processes to fire 5 simultaneous orders:
for i in $(seq 1 5); do
  curl -s -o /tmp/order_result_$i.json -w "%{http_code}" \
    -X POST http://localhost:8000/v1/orders \
    -H "Authorization: Bearer $BUYER" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\":\"$TICKET_ID\"}" &
done
wait

# Check results:
for i in $(seq 1 5); do echo "Request $i:"; cat /tmp/order_result_$i.json; echo; done
```

**Expected:** exactly 1 request returns `201`; the rest return `409 Conflict` (or `400` if the ticket was already reserved from a previous test run).

### 6.3 Redis down — 503 fallback

```bash
# Stop Redis:
docker compose stop redis

# Attempt to create an order:
curl -s -X POST http://localhost:8000/v1/orders \
  -H "Authorization: Bearer $BUYER" \
  -H "Content-Type: application/json" \
  -d "{\"ticketId\":\"$TICKET_ID\"}"
# Expected: 503 Service Unavailable

# Check error body shape:
# Expected:
# {
#   "error": {
#     "code": "SERVICE_UNAVAILABLE",
#     "message": "..."
#   }
# }

# Restart Redis:
docker compose start redis
```

### 6.4 Verify lock key in Redis

```bash
# In one terminal, start watching Redis:
docker compose exec redis redis-cli monitor | grep lock

# In another terminal, fire an order creation request (from step 6.1):
curl -s -X POST http://localhost:8000/v1/orders \
  -H "Authorization: Bearer $BUYER" \
  -H "Content-Type: application/json" \
  -d "{\"ticketId\":\"$TICKET_ID\"}"

# In the monitor terminal, you should see:
# "SET" "order-service:lock:ticket:<ticketId>" ...
# followed shortly by:
# "DEL" "order-service:lock:ticket:<ticketId>"
```

---

## 7. Full E2E Playwright Regression (Docker Compose)

After all smoke tests pass, run the existing Playwright suite to confirm no regressions:

```bash
# In services/client/, start the Next.js dev server:
cd services/client
pnpm dev --port 4000 &

# Run the full suite (from services/client/):
pnpm exec playwright test --reporter=list
```

**Expected:** 18/18 tests pass. Any failure here indicates a regression introduced by this change.

---

## 8. Kubernetes (minikube) E2E Test Plan

This section covers verification after deploying the staged changes to the local minikube cluster via `./infra/local/setup.sh`.

### 8.1 Prerequisites

```bash
# Ensure minikube is running:
minikube status

# Ensure minikube tunnel is running (in a separate terminal, may require sudo):
sudo minikube tunnel

# Kong proxy should be reachable:
curl -s http://localhost:8000/healthz  # or any Kong route
```

### 8.2 Deploy the changes to minikube

```bash
# Rebuild all images and redeploy (idempotent):
./infra/local/setup.sh

# Alternatively, for a faster incremental update of only the changed services:
docker build -t ticket-service:local services/ticket-service/
docker build -t order-service:local services/order-service/
docker build -t kong-gateway:local services/kong-gateway/
minikube image load ticket-service:local
minikube image load order-service:local
minikube image load kong-gateway:local

kubectl rollout restart deployment/ticketing-ticket-service -n ticketing
kubectl rollout restart deployment/ticketing-order-service -n ticketing
kubectl rollout restart deployment/ticketing-kong -n ticketing

# Wait for all pods to be ready:
kubectl rollout status deployment/ticketing-ticket-service -n ticketing
kubectl rollout status deployment/ticketing-order-service -n ticketing
kubectl rollout status deployment/ticketing-kong -n ticketing
```

### 8.3 Verify `REDIS_URL` is injected correctly in pods

```bash
# ticket-service:
kubectl exec -n ticketing deploy/ticketing-ticket-service -- env | grep REDIS_URL
# Expected: REDIS_URL=redis://ticketing-redis-master.ticketing.svc.cluster.local:6379

# order-service:
kubectl exec -n ticketing deploy/ticketing-order-service -- env | grep REDIS_URL
# Expected: REDIS_URL=redis://ticketing-redis-master.ticketing.svc.cluster.local:6379
```

### 8.4 Verify Kong rate-limiting plugin is active in cluster

```bash
# Port-forward Kong admin API:
kubectl port-forward -n ticketing svc/ticketing-kong-admin 8444:8444 &

curl -sk https://localhost:8444/plugins \
  | jq '[.data[] | select(.name=="rate-limiting") | {name, route: .route, config: {minute: .config.minute, policy: .config.policy, limit_by: .config.limit_by}}]'
```

**Expected:** 3 rate-limiting plugin instances visible, all with `policy: local` (minikube uses `values-local.yaml`).

### 8.5 Verify Redis connectivity from inside pods

```bash
# From ticket-service pod:
kubectl exec -n ticketing deploy/ticketing-ticket-service -- \
  sh -c 'nc -zv ticketing-redis-master 6379 && echo "Redis reachable"'
# Expected: Redis reachable

# From order-service pod:
kubectl exec -n ticketing deploy/ticketing-order-service -- \
  sh -c 'nc -zv ticketing-redis-master 6379 && echo "Redis reachable"'
# Expected: Redis reachable
```

### 8.6 Run the Playwright E2E suite against minikube

The Playwright tests use `BASE_URL` (defaults to `http://localhost:4000` for the Next.js dev server). In minikube, Kong is the entry point on `localhost:8000` (via `minikube tunnel`).

```bash
# Start the Next.js dev server (still needed — it proxies to Kong):
cd services/client
pnpm dev --port 4000 &

# Run full suite:
pnpm exec playwright test --reporter=list
```

**Expected:** 18/18 tests pass (same baseline as Docker Compose). If Kafka is disabled (default in minikube via `kafka.enabled: false`), the payment-flow test (`order shows paid after payment captured`) will fail or be skipped — this is expected and pre-existing.

### 8.7 Cache behaviour in-cluster (Redis CLI via kubectl)

```bash
# Open a Redis CLI session inside the cluster:
kubectl exec -n ticketing -it deploy/ticketing-redis-master -- redis-cli

# In redis-cli:
KEYS ticket-service:*
# Initially empty.

# After fetching tickets via Kong:
# (in a separate terminal)
TOKEN=$(curl -s -X POST http://localhost:8000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"k8s@test.com","password":"password123"}' | jq -r '.token')
curl -s http://localhost:8000/v1/tickets -H "Authorization: Bearer $TOKEN"

# Back in redis-cli:
KEYS ticket-service:*
# Expected: ticket-service:tickets:list
```

### 8.8 Lock key visibility in-cluster

```bash
# Monitor Redis from within the cluster:
kubectl exec -n ticketing -it deploy/ticketing-redis-master -- redis-cli monitor &

# Fire a concurrent order request (see section 6.2 for multi-request loop).
# In the monitor output, look for:
# "SET" "order-service:lock:ticket:<id>" ...
# "DEL" "order-service:lock:ticket:<id>"
```

### 8.9 Pod restart resilience (Redis down in cluster)

```bash
# Scale Redis to 0 replicas:
kubectl scale statefulset ticketing-redis-master -n ticketing --replicas=0

# Confirm ticket-service still responds (NoopCache fallback → MongoDB):
curl -s http://localhost:8000/v1/tickets -H "Authorization: Bearer $TOKEN"
# Expected: 200 with ticket list

# Confirm order-service returns 503:
curl -s -X POST http://localhost:8000/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ticketId":"any-id"}'
# Expected: 503

# Restore Redis:
kubectl scale statefulset ticketing-redis-master -n ticketing --replicas=1
kubectl rollout status statefulset/ticketing-redis-master -n ticketing
```

### 8.10 Check pod logs for errors

```bash
# ticket-service — should show no ERROR or FATAL lines related to Redis:
kubectl logs -n ticketing deploy/ticketing-ticket-service --since=10m | grep -iE "error|fatal|panic" | grep -iv "level=warn"

# order-service — should show no ERROR lines related to Redisson:
kubectl logs -n ticketing deploy/ticketing-order-service --since=10m | grep -iE "ERROR|FATAL" | grep -iv "WARN"

# Kong — should show 429 responses when rate limit triggered:
kubectl logs -n ticketing deploy/ticketing-kong --since=10m | grep "429"
```

---

## 9. Known Limitations & Caveats

| Item | Detail |
|---|---|
| **Rate-limit Redis policy not tested locally** | `policy: local` is used in all non-cloud environments. The `redis` policy (staging/prod) requires a deployed Redis-backed Kong — not exercisable locally without overriding the values file. |
| **Kafka disabled in minikube** | `kafka.enabled: false` in `values-local.yaml`. The payment E2E test publishes directly to `localhost:9093` (external Kafka listener). This is unavailable in minikube — the payment Playwright test will fail in-cluster. This is pre-existing, not introduced by this change. |
| **Empty `redis_host` in Kong config** | When `RATE_LIMIT_REDIS_HOST` is `""` (local/dev envs), `redis_host: ""` is written into the rendered `kong.yml`. Kong's `policy: local` ignores this field, so it is harmless. Verify Kong starts without complaints by checking `docker compose logs kong \| grep -i error`. If Kong rejects empty `redis_host`, set it to `"localhost"` as a dummy value in `_defaults.yml`. |
| **minikube image pull policy** | All app images use `imagePullPolicy: IfNotPresent`. If you load a new `ticket-service:local` but the pod already has the old image, force a reload: `kubectl rollout restart deployment/ticketing-ticket-service -n ticketing`. |
| **Lock TTL** | The Redisson lock TTL is 5 seconds (the `leaseTime` in `tryLock(0, 5, SECONDS)`). Under normal operation, `createOrder` completes well within 5 s. Under pathological DB slowness, the lock could expire while the transaction is still running, allowing a second request to proceed. This is an acceptable trade-off for local dev; tighten the lease time or use watchdog-based locks for production. |

---

## 10. Sign-off Checklist

Before requesting merge approval:

- [ ] All unit tests pass (`go test ./internal/...` in ticket-service, `mvn -Dtest=OrderServiceTest test` in order-service)
- [ ] All integration tests pass (`go test ./test/...` in ticket-service, `mvn verify -Dit.test=OrderIntegrationTest` in order-service)
- [ ] Kong config renders without errors (`bash services/kong-gateway/scripts/build.sh local && docker compose restart kong && docker compose logs kong | grep -i error`)
- [ ] Cache smoke tests pass (sections 5.2–5.4)
- [ ] Lock smoke tests pass (sections 6.1–6.4)
- [ ] 18/18 Playwright tests pass against Docker Compose
- [ ] Kubernetes deploy verified (section 8.2)
- [ ] `REDIS_URL` confirmed injected in both pods (section 8.3)
- [ ] Redis connectivity confirmed from both pods (section 8.5)
- [ ] Pod logs clean — no unexpected ERROR/FATAL lines (section 8.10)
