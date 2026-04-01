# CP-06 — GA Rollout: Migration Order and Rollback Notes

**Status:** Verified locally — 2026-04-02  
**Related:** [`ticketing-enhancement-scrum-checklist.md`](ticketing-enhancement-scrum-checklist.md)

---

## Scope

This document covers the deployment order and rollback plan for the GA quota
reservation enhancement (CP-01 through CP-05). The new flow introduces:

- `ticket-service` — quota fields (`quota`, `reserved`, `sold`, `maxPerUser`),
  reservation ledger collection, Redis quota manager.
- `order-service` — `quantity` and `reservationId` columns, gRPC
  `ReserveQuota`/`ReleaseReservation`/`FinalizeReservation` calls, updated
  outbox payloads.

---

## Deployment Order

Deploy in this exact sequence to ensure backward compatibility at each step.
Each service must be healthy before proceeding to the next.

### Step 1 — ticket-service

1. Apply the MongoDB schema changes (new fields and reservation collection). The
   schema additions are **additive only** — existing tickets gain default values
   (`quota=1`, `reserved=0`, `sold=0`, `maxPerUser=1`).
2. Deploy the new `ticket-service` image.
3. Smoke-check: `GET /healthz/ready` returns 200; `GET /api/tickets` returns
   existing tickets with new quota fields defaulted.

**Why first:** `order-service` calls `ticket-service` gRPC. The new gRPC RPCs
(`ReserveQuota`, `ReleaseReservation`, `FinalizeReservation`) must be available
before `order-service` is deployed. The deprecated `ValidateTicketAvailability`
RPC is kept running in this build so the old `order-service` continues to work
during the window between Step 1 and Step 2.

### Step 2 — order-service

1. Run the Flyway migration to add `quantity` (default 1) and `reservation_id`
   (nullable) columns to the `orders` table. The migration is safe to run
   against a live database — existing rows get `quantity=1`,
   `reservation_id=NULL`.
2. Deploy the new `order-service` image.
3. Smoke-check: `POST /api/orders` creates orders with `reservationId` in the
   response; `DELETE /api/orders/:id` triggers `ReleaseReservation` on
   ticket-service via Kafka.

**Why second:** The new order-service image calls the new gRPC RPCs and emits
enriched Kafka events with `reservationId`. Both require ticket-service (Step 1)
to be running first.

### Step 3 — payment-service (no schema change needed)

No code change in payment-service for the GA path. Existing
`payments.payment.captured` events already carry `orderId`; order-service maps
`orderId → reservationId` internally via the order record.

Confirm `payment-service` health unchanged after Steps 1 and 2.

### Step 4 — expiration-service (no schema change needed)

No code change in expiration-service for the GA path. Expired order events
(`orders.order.cancelled` with `reservationId`) are consumed by ticket-service
and handled via `ReleaseReservation`.

### Step 5 — client

Deploy after all backend services are healthy. The client changes (price type
fix, `reserved`/`quota`/`sold` display, "Already Reserved" guard) are fully
backward compatible — they read optional fields from the API response.

---

## Feature Flag / Dual-Write Window

Both the legacy path (`orderId` on tickets) and the new reservation path
(`reservationId` in orders + reservation ledger in ticket-service) coexist
during the deployment window:

- ticket-service consumers check for `reservationId` in the Kafka event:
  - present → GA path (`ReleaseReservation` / `FinalizeReservation`)
  - absent → legacy path (`ReleaseTicket`)
- This allows old `order-service` instances to continue working during the
  rolling restart.

The legacy path should be removed in a follow-up PR once the rollout is
confirmed stable (suggest 2 weeks post-deploy).

---

## Rollback Plan

### Rollback Step 2 (order-service only)

1. Re-deploy the previous `order-service` image.
2. The `quantity` and `reservation_id` columns added by Flyway are nullable with
   defaults — the old code ignores them safely. **Do not drop the columns** —
   Flyway migrations are append-only.
3. Kafka events emitted during the new-version window contain `reservationId`.
   ticket-service's GA consumer will process them correctly even after
   order-service is rolled back.

### Rollback Step 1 (ticket-service only)

Requires rolling back order-service first (see above), then:

1. Re-deploy the previous `ticket-service` image.
2. The quota fields (`quota`, `reserved`, `sold`, `maxPerUser`) and the
   `ticket_reservations` collection are **not dropped** — the old image simply
   ignores them.
3. Reservation documents written during the new-version window will remain in
   MongoDB but will not be consumed by the old ticket-service. They do not
   corrupt the legacy `orderId` field.

### Full Rollback (both services)

Roll back order-service before ticket-service (reverse of deployment order).

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Reservation counter drift if ticket-service restarts mid-reserve | Low | MongoDB `findOneAndUpdate` is atomic; Redis is re-seeded on startup |
| Kafka at-least-once delivery causes double-finalize | Medium | `FinalizeReservation` is idempotent (SOLD→SOLD no-op) |
| Kafka at-least-once delivery causes double-release | Medium | `ReleaseReservation` is idempotent (RELEASED→RELEASED no-op) |
| Existing tickets with `quota=0` fail schema validation | Low | Schema enforces `minimum: 1`; backfill sets `quota=1` on 0-value rows before deploy |
| Old order-service calls deprecated `ValidateTicketAvailability` RPC | High (expected) | Deprecated RPC kept live — returns `available = quota - reserved - sold` |

---

## Smoke Test Evidence (local, 2026-04-02)

All tests run against Docker Compose stack on `main` (post-PR-#23).

### AC-1: create → cancel → re-purchase ✅

```
Ticket f59b4125 (quota=2, maxPerUser=2)
After buyer1 reserves 1:    reserved=1, sold=0
After buyer1 cancels:       reserved=0, sold=0  ← Kafka propagation ~3 s
After buyer2 reserves 2:    reserved=2, sold=0  ← full quota restored
```

### AC-2: create → payment complete → sold counters correct ✅

```
After buyer2 payment captured:
  Order status: complete
  Ticket:       reserved=0, sold=2  (quota invariant: 0+2 = quota)
```

### AC-3: duplicate event replay is harmless ✅

```
2× duplicate orders.order.completed published to Kafka
Ticket after replay:  reserved=0, sold=2, version=5  ← unchanged
```

### Test suite results

```
ticket-service:  go test ./...  — all pass (including 3 new TestGA_E2E_* tests)
order-service:   mvn -q test    — 16/16 pass
```
