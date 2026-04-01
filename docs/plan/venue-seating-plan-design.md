# Venue Seating Plan System — Detailed Design Document

**Status:** REVISED — implementation-ready baseline after architecture review 2026-04-01  
**Author:** Principal Engineer (Agent)  
**Date:** 2026-04-01  
**Scope:** new `venue-service`, changes to `order-service`, `ticket-service`, `proto`, `client`  
**Companion doc:** [`docs/plan/quota-reservation-design.md`](quota-reservation-design.md) for GA quota inventory  

---

## 1. Executive Summary

Add an optional **venue seating plan system** for reserved-seat events.

This revision keeps the original product goals but changes the inventory architecture in four important ways:

1. `venue-service` owns all seated inventory and seat reservations end to end.
2. seat purchase operations are keyed by **reservationId**, not by raw `seatIds` or `orderId` alone.
3. the ticket-to-plan lifecycle is changed to remove the earlier creation deadlock.
4. Redis key design is made compatible with Redis Cluster.

### Product Goals

Organizers can:

- create reusable venue templates
- create event-specific seating plans from scratch or from a template
- define seated and GA sections in the same plan
- define tier pricing and seat attributes
- configure manual pick or auto-assign
- configure hold TTL and max seats per order

Buyers can:

- view a live seat map
- hold seats briefly during checkout
- buy multiple seats in one order
- optionally submit attendee names per seat

### V1 Scope Boundary

For V1, one order may purchase from exactly one inventory mode:

- GA-only ticket handled by `ticket-service`
- seated ticket handled by `venue-service`

Mixed seated + GA sections inside one seating plan are allowed for catalog and venue modeling, but **one checkout request must target one section type only**. Cross-mode basket orchestration is deferred because it requires a larger compensation saga.

---

## 2. Key Decisions

| # | Decision | Choice |
|---|---|---|
| D-01 | Service boundary | New `venue-service` owns seated inventory and holds |
| D-02 | Purchase identity | Every seated inventory operation is keyed by `reservationId` |
| D-03 | Seat selection | Manual and auto-assign both supported |
| D-04 | Hold model | Soft hold with TTL, then hard reservation during checkout |
| D-05 | Real-time updates | SSE in V1 |
| D-06 | Ticket/plan binding | Ticket is created first, plan attached later before activation |
| D-07 | Redis topology | Cluster-safe keys using hash tags |
| D-08 | External identity | user identity comes from Kong-injected auth context, not request body |
| D-09 | Seat model | one order can contain many seats |
| D-10 | Mixed-mode checkout | deferred beyond V1 |

---

## 3. Architecture Overview

```text
Client
  -> Kong
    -> ticket-service   (ticket catalog, GA quota)
    -> venue-service    (seat map, holds, seated reservations, SSE)
    -> order-service    (order creation and lifecycle)

order-service
  -> ticket-service gRPC for GA-only purchase
  -> venue-service  gRPC for seated purchase

order-service
  -> Kafka orders.order.created
  -> Kafka orders.order.cancelled
  -> Kafka orders.order.completed

venue-service
  <- Kafka orders.order.cancelled
  <- Kafka orders.order.completed
```

### Responsibility Split

| Service | Owns |
|---|---|
| `ticket-service` | ticket catalog and GA quota inventory |
| `venue-service` | seating plans, seats, held/reserved/sold seat state, seated reservation ledger |
| `order-service` | order rows, order-seat rows, outbox |

If a ticket has `seatingPlanId`, `ticket-service` does not own its purchase inventory. It only exposes catalog metadata.

---

## 4. Ticket and Seating Plan Lifecycle

### 4.1 Revised Binding Flow

The earlier draft had a deadlock because plan creation required `ticketId` while ticket creation also expected `seatingPlanId`.

The corrected lifecycle is:

1. organizer creates a draft ticket in `ticket-service`
2. organizer creates a seating plan in `venue-service` with `ticketId`
3. organizer edits and validates the plan
4. organizer attaches the resulting `seatingPlanId` to the ticket
5. organizer activates sale only after the plan is valid and attached

### 4.2 Ticket Rules

For a seated ticket:

- `ticket-service` stores `seatingPlanId`
- ticket `quota`, `reserved`, `sold` are not used for seated inventory
- ticket price becomes a catalog base price only; final sell price comes from seat tier snapshot

### 4.3 Plan Activation Rule

A seating plan can move from `draft` to `active` only when:

- it is attached to a ticket
- it has at least one purchasable section
- all seats and tiers validate
- Redis seed succeeds

---

## 5. Seated Inventory Model

### 5.1 Seat State Machine

```text
AVAILABLE -> HELD -> RESERVED -> SOLD
AVAILABLE -> BLOCKED
HELD -> AVAILABLE
RESERVED -> AVAILABLE
BLOCKED -> AVAILABLE
```

Transition semantics:

- `HELD` is shopper-scoped soft state with TTL
- `RESERVED` is durable inventory committed to a reservation ledger
- `SOLD` is terminal
- `BLOCKED` is organizer-controlled and not sellable

### 5.2 Reservation Ledger

Add a durable seated reservation record in `venue-service`:

```text
seat_reservations
  id               UUID      primary key          -- reservationId
  plan_id          UUID
  ticket_id        UUID
  order_id         UUID null
  user_id          UUID
  section_id       UUID null
  status           TEXT      RESERVED | RELEASED | SOLD | EXPIRED
  expires_at       TIMESTAMPTZ null
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

Each reservation has child rows:

```text
seat_reservation_items
  reservation_id   UUID
  seat_id          UUID
  section_id       UUID
  price            NUMERIC(12,2)
  seat_label       TEXT
```

Why this matters:

- idempotent release and finalize
- durable link from held seats to order
- auditability for disputed purchases
- safer reconciliation than seat state alone

---

## 6. Redis Design

### 6.1 Cluster-Safe Keys

Use one hash tag per plan:

```text
venue:{planId}:seats                     -> HASH   seatId -> stateByte
venue:{planId}:hold:{seatId}            -> STRING hold metadata with TTL
venue:{planId}:user-holds:{userId}      -> SET    held seatIds with TTL
venue:{planId}:changes                  -> PUBSUB channel
venue:{planId}:ga:{sectionId}:available -> STRING GA count for GA sections inside the plan
```

This avoids Redis Cluster cross-slot script failures.

### 6.2 Hold Metadata

Store:

- `userId`
- `sessionId`
- `heldAt`
- `expiresAt`
- optional `reservationCandidateId`

### 6.3 Persistence Rule

Redis remains the hot path only. PostgreSQL reservation rows and seat state remain the durable source of truth.

Never return seated reservation success unless the durable reservation write also succeeds.

---

## 7. Public REST API

### 7.1 Seat Hold

```text
POST /api/seating-plans/:planId/seats/hold
```

Request body:

```json
{
  "seatIds": ["seat-1", "seat-2"],
  "sessionId": "client-session-id"
}
```

Notes:

- do not accept `userId` from the client body
- derive user identity from Kong-authenticated request context
- reject unknown fields

Response:

```json
{
  "held": ["seat-1", "seat-2"],
  "expiresAt": "2026-04-01T10:00:00Z"
}
```

### 7.2 Release Hold

```text
POST /api/seating-plans/:planId/seats/release
```

### 7.3 Availability Snapshot

```text
GET /api/seating-plans/:planId/availability
```

### 7.4 SSE

```text
GET /api/seating-plans/:planId/events
Accept: text/event-stream
```

---

## 8. gRPC Contract

```protobuf
service VenueService {
  rpc ReserveHeldSeats(ReserveHeldSeatsRequest) returns (ReserveHeldSeatsResponse);
  rpc AutoAssignAndReserve(AutoAssignAndReserveRequest) returns (AutoAssignAndReserveResponse);
  rpc ReleaseSeatReservation(ReleaseSeatReservationRequest) returns (ReleaseSeatReservationResponse);
  rpc FinalizeSeatReservation(FinalizeSeatReservationRequest) returns (FinalizeSeatReservationResponse);
  rpc GetSeatingPlan(GetSeatingPlanRequest) returns (GetSeatingPlanResponse);
}

message ReserveHeldSeatsRequest {
  string plan_id = 1;
  string ticket_id = 2;
  string reservation_id = 3;
  string user_id = 4;
  repeated string seat_ids = 5;
  google.protobuf.Timestamp expires_at = 6;
}

message ReserveHeldSeatsResponse {
  bool success = 1;
  string reservation_id = 2;
  repeated SeatDetail seats = 3;
  repeated string unavailable_seat_ids = 4;
}

message AutoAssignAndReserveRequest {
  string plan_id = 1;
  string ticket_id = 2;
  string section_id = 3;
  string reservation_id = 4;
  string user_id = 5;
  int32 quantity = 6;
  google.protobuf.Timestamp expires_at = 7;
}

message AutoAssignAndReserveResponse {
  bool success = 1;
  string reservation_id = 2;
  repeated SeatDetail seats = 3;
}

message ReleaseSeatReservationRequest {
  string reservation_id = 1;
  string reason = 2; // CANCELLED | EXPIRED | COMPENSATION
}

message ReleaseSeatReservationResponse {
  bool success = 1;
}

message FinalizeSeatReservationRequest {
  string reservation_id = 1;
  string order_id = 2;
}

message FinalizeSeatReservationResponse {
  bool success = 1;
}
```

Important change from the earlier draft:

- pre-order reservation RPCs no longer require `order_id`
- `order_id` is only supplied once the order exists

---

## 9. Seated Purchase Flows

### 9.1 Manual Selection

```text
1. user holds seats via venue-service REST
2. user clicks purchase
3. order-service generates reservationId
4. order-service calls ReserveHeldSeats(planId, ticketId, reservationId, userId, seatIds)
5. venue-service verifies seats are held by that user or can be atomically re-held if still available
6. venue-service transitions seats HELD -> RESERVED
7. venue-service writes reservation ledger rows
8. venue-service returns seat snapshot and reservationId
9. order-service creates order + order_seats + outbox in one transaction
10. if transaction fails, order-service calls ReleaseSeatReservation(reservationId, COMPENSATION)
```

### 9.2 Auto-Assign

```text
1. user selects section + quantity
2. order-service generates reservationId
3. order-service calls AutoAssignAndReserve(...)
4. venue-service finds best block and atomically reserves it
5. venue-service persists reservation ledger rows
6. order-service creates order using returned seats
```

### 9.3 Cancel / Expire / Complete

```text
orders.order.cancelled -> venue-service -> ReleaseSeatReservation(reservationId)
orders.order.completed -> venue-service -> FinalizeSeatReservation(reservationId, orderId)
```

These operations are idempotent by reservation state.

---

## 10. Auto-Assign Algorithm

The earlier design is still directionally correct.

### V1 Strategy

1. row-based fast path for traditional layouts
2. contiguous run scoring within row
3. front-center weighting
4. cross-row fallback only when no same-row block exists

### Guardrails

- do not brute-force all subsets
- cap search windows for large sections
- final seat claim must still be done atomically in the reservation script or DB transaction boundary

---

## 11. Data Model

### 11.1 venue-service PostgreSQL

Core tables:

- `venues`
- `seating_plans`
- `sections`
- `price_tiers`
- `seats`
- `seat_reservations`
- `seat_reservation_items`

### 11.2 Corrected Plan Binding

`seating_plans.ticket_id` should be nullable during draft creation and become required before activation.

Recommended shape:

```sql
ALTER TABLE seating_plans
    ALTER COLUMN ticket_id DROP NOT NULL;
```

Enforce attachment at application level for `status = 'active'`.

This is preferable to a hard bootstrap cycle between services.

### 11.3 seats Table

Keep:

- `status`
- `held_by`
- `held_until`
- `reserved_by_order`
- `attributes`
- `version`

But treat `reserved_by_order` as a convenience projection only. The reservation ledger is the durable source of truth.

---

## 12. Order-Service Changes

### 12.1 Order Model

Add:

- `reservationId`
- `quantity`

For seated orders, add `order_seats` child rows.

### 12.2 CreateOrderRequest

```java
public class CreateOrderRequest {
    private String ticketId;
    private List<String> seatIds;
    private String sectionId;
    private int quantity = 1;
    private List<AttendeeInfo> attendees;
}
```

Validation rules:

- manual seat purchase: `seatIds` required, `quantity` must equal `seatIds.size()`
- auto-assign seated purchase: `sectionId` + `quantity` required, `seatIds` absent
- GA-only purchase: handled by the quota doc flow
- reject combinations that target multiple inventory modes in one request

### 12.3 Events

`orders.order.created`, `orders.order.cancelled`, and `orders.order.completed` must all include:

- `reservationId` when the order came from a reservation flow
- `seatIds` for seated orders
- `quantity`

---

## 13. Ticket-Service Changes

### 13.1 Ticket Model

Add optional `seatingPlanId`:

```go
type Ticket struct {
    ID            string    `bson:"_id"`
    Title         string    `bson:"title"`
    Price         string    `bson:"price"`
    UserID        string    `bson:"userId"`
    SeatingPlanID string    `bson:"seatingPlanId,omitempty"`
    MaxPerUser    int       `bson:"maxPerUser"`
    Version       int       `bson:"version"`
    CreatedAt     time.Time `bson:"createdAt"`
    UpdatedAt     time.Time `bson:"updatedAt"`
}
```

### 13.2 Catalog Behavior

If `seatingPlanId` is present:

- purchase availability comes from `venue-service`
- ticket-service still serves the catalog entry
- ticket-service does not attempt to reserve quota for that ticket

### 13.3 Validation

On attach:

- ticket-service validates the seating plan exists and is owned by the same organizer
- venue-service validates the plan is still in `draft` or attachable state

---

## 14. Real-Time Availability

SSE remains the right V1 transport.

Requirements:

- batch seat changes in short windows under heavy load
- include heartbeat events
- re-fetch full availability snapshot after reconnect
- never treat client SSE state as authoritative for checkout

The final reservation RPC remains the authority.

---

## 15. Security and Industry-Practice Corrections

### Corrected From Earlier Draft

1. `userId` is removed from public hold request bodies.
2. pre-order reserve RPCs no longer require `orderId`.
3. multi-key Redis scripts are now cluster-safe.
4. reservation identity is durable and idempotent.
5. shared PostgreSQL schema is not recommended; prefer a dedicated venue database.

### Additional Notes

- attendee names are PII and must not be logged
- rate limit hold endpoints aggressively at Kong and service level
- sanitize seat labels and organizer-defined names before logging

---

## 16. Implementation Phases

### Phase 0: Proto

1. create `proto/venue/v1/venue.proto`
2. add `seating_plan_id` to ticket proto responses
3. regenerate stubs

### Phase 1: venue-service scaffold

1. config, logger, tracing, health
2. PostgreSQL migrations
3. Redis wiring
4. SSE broadcaster

### Phase 2: template and plan CRUD

1. venue templates
2. draft seating plans
3. attach plan to ticket
4. activate plan

### Phase 3: seat hold system

1. cluster-safe Lua scripts
2. hold / release endpoints
3. sweeper for expired holds

### Phase 4: reservation ledger

1. `ReserveHeldSeats`
2. `AutoAssignAndReserve`
3. `ReleaseSeatReservation`
4. `FinalizeSeatReservation`

### Phase 5: order-service integration

1. add `reservationId`
2. add `OrderSeat`
3. wire seated create-order flows
4. publish updated events

### Phase 6: client

1. seat map viewer
2. hold interaction
3. checkout integration
4. organizer editor

### Phase 7: reconciliation and hardening

1. Redis vs PostgreSQL drift checks
2. alerting and metrics
3. load tests

---

## 17. Rollout and Migration

Deploy in this order:

1. deploy `venue-service`
2. deploy additive ticket proto and ticket-service changes
3. deploy order-service changes
4. add Kong routes
5. release client UI

Backward compatibility:

- tickets without `seatingPlanId` remain GA-only
- existing orders remain valid with no `order_seats`
- old clients continue to use GA-only purchase paths

---

## 18. QA and Verification Strategy

### Unit

- one user cannot double-hold the same seat incorrectly
- another user cannot hold an already held seat
- reserve from held seats is idempotent by `reservationId`
- release is idempotent
- finalize is idempotent
- auto-assign returns best valid block for test layouts

### Integration

- 100 concurrent holds on one seat -> exactly one success
- duplicate cancel and complete events do not corrupt state
- expired holds are released without blocking new holds
- Redis restart is recoverable from PostgreSQL + reservation ledger

### Load

- high fan-out SSE remains within latency target
- auto-assign under concurrency does not overlap seats
- no double-sell under checkout burst

### E2E

- create draft ticket -> create plan -> attach -> activate -> purchase
- hold and purchase manual seats
- auto-assign purchase
- expired hold rejection and re-selection

---

## 19. Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Double-sell under race | Critical | atomic hold/reserve + durable reservation ledger |
| Ticket/plan creation deadlock | Critical | revised attach flow with draft ticket first |
| Duplicate Kafka finalization | High | reservationId-based idempotency |
| Redis Cluster cross-slot failure | High | hash-tagged key design |
| Seat map staleness | Medium | SSE for UX, reserve RPC as authority |
| PII leakage in logs | High | do not log attendee names or raw request bodies |

---

## 20. Final Recommendation

This revised design is a much better fit for cinema and Ticketmaster-style seat purchase than the earlier draft because it fixes the two most important correctness problems:

1. inventory mutations are now tied to a durable `reservationId`
2. the ticket and seating plan lifecycle no longer deadlocks at creation time

For V1, keep the scope disciplined:

- GA-only purchases through `ticket-service`
- seated purchases through `venue-service`
- defer mixed cross-mode checkout until the reservation saga is intentionally designed
