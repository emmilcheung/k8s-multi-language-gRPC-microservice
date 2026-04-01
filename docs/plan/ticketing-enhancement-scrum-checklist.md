# Ticketing Enhancement Scrum Checklist

**Status:** Active working checklist  
**Date:** 2026-04-01  
**Related docs:**

- [`quota-reservation-design.md`](quota-reservation-design.md)
- [`venue-seating-plan-design.md`](venue-seating-plan-design.md)

---

## 1. How To Use This Checklist

This file breaks the ticketing enhancement into **review-sized checkpoints** so work can be split across multiple parties while keeping architecture and code review manageable.

### Rules

- Each checkpoint should be small enough for one PR or one closely related PR set.
- Do not start a checkpoint marked with unmet dependencies unless the dependency is intentionally being developed in parallel and the integration contract is already fixed.
- Keep acceptance criteria and verification evidence inside the PR description.
- Update the checkbox state and owner tag when work starts or finishes.

### Suggested Status Markers

- `[ ]` not started
- `[-]` in progress
- `[x]` completed
- `[!]` blocked

### Suggested Owner Format

- `Owner: @name`
- `Reviewers: @name1 @name2`

---

## 2. Workstream Overview

| Workstream | Purpose |
|---|---|
| WS-01 | Contracts and shared schemas |
| WS-02 | Quota inventory foundation in `ticket-service` |
| WS-03 | Order-service quota integration |
| WS-04 | New `venue-service` foundation |
| WS-05 | Seat hold and seated reservation flow |
| WS-06 | Order-service seated integration |
| WS-07 | Client and organizer UI |
| WS-08 | Reconciliation, observability, load and E2E hardening |

---

## 3. Dependency Map

```text
CP-01 -> CP-02 -> CP-03 -> CP-04 -> CP-05 -> CP-06
CP-01 -> CP-07 -> CP-08 -> CP-09 -> CP-10 -> CP-11
CP-04 -> CP-12
CP-10 -> CP-13
CP-06 + CP-11 + CP-12 + CP-13 -> CP-14
CP-12 + CP-13 + CP-14 -> CP-15
```

Meaning:

- quota path can move first end to end
- venue path can progress in parallel after contracts are stable
- client and hardening tracks should land after service contracts settle

---

## 4. Checkpoints

## CP-01 Shared Contracts And Event Schema

- [x] Finalize proto and event contracts

Owner:

- `Owner: @agent`
- `Reviewers: TBD`

Scope:

- update `proto/tickets/v1/tickets.proto`
- create `proto/venue/v1/venue.proto`
- define reservation-based order event payload changes
- confirm CloudEvents fields for new lifecycle messages

Deliverables:

- `ReserveQuota`, `ReleaseReservation`, `FinalizeReservation` for GA
- seated reservation RPCs for `venue-service`
- `reservationId` and `quantity` added to relevant order events
- `orders.order.completed` contract finalized

Dependencies:

- none

Acceptance criteria:

- no pre-order RPC requires `orderId`
- all purchase write paths are keyed by `reservationId`
- all new money fields use decimal string in gRPC and events
- generated stubs compile for Go and Java

Verification:

- `make proto`

---

## CP-02 Ticket-Service Quota Schema And Repository Foundation

- [ ] Introduce quota fields and reservation ledger in `ticket-service`

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- extend ticket model with `quota`, `reserved`, `sold`, `maxPerUser`
- add reservation collection and repository interfaces
- add Mongo schema validation and indexes
- write migration/backfill notes or scripts for local testing

Deliverables:

- ticket document shape updated
- durable `TicketReservation` storage added
- old `orderId` field isolated behind backward-compat migration plan

Dependencies:

- CP-01

Acceptance criteria:

- repository can create, read, release, and finalize reservations by `reservationId`
- repository methods are idempotent at the data layer
- schema/index definitions are additive-first for rollout

Verification:

- `go test ./...`
- `go vet ./...`

---

## CP-03 Ticket-Service Redis Quota Manager

- [ ] Implement cluster-safe Redis Lua scripts for quota reservation

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- add Redis keys with hash tags
- reserve / release / finalize scripts
- integrate Redis manager with durable repository path
- add fallback and compensation behavior

Deliverables:

- `ticket-service:{ticketId}:available`
- `ticket-service:{ticketId}:user-reserved:{userId}`
- atomic per-user limit enforcement in reserve flow

Dependencies:

- CP-02

Acceptance criteria:

- reserve never succeeds if durable persistence fails
- release and finalize are idempotent
- design remains valid for Redis Cluster

Verification:

- `go test ./...`
- targeted integration tests with Redis

---

## CP-04 Ticket-Service gRPC And Kafka Reservation Lifecycle

- [ ] Expose the new GA reservation lifecycle externally and asynchronously

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- implement new gRPC RPCs
- keep deprecated `ValidateTicketAvailability` temporarily
- update Kafka consumer behavior for cancel and complete
- add structured logs and metrics

Deliverables:

- `ReserveQuota`
- `ReleaseReservation`
- `FinalizeReservation`
- idempotent `orders.order.cancelled` and `orders.order.completed` handling

Dependencies:

- CP-03

Acceptance criteria:

- duplicate events do not corrupt counters
- deprecated availability uses `quota - reserved - sold`
- gRPC status codes match platform guidance

Verification:

- `go test ./...`
- smoke test with local Kafka path

---

## CP-05 Order-Service GA Reservation Integration

- [ ] Move order creation to reservation-based GA flow

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- add `quantity` and `reservationId` to order model
- add/update Flyway migration
- call `ReserveQuota` before transactional order creation
- compensate with `ReleaseReservation` on failure
- remove Redisson from target path or guard it behind a short-lived migration flag

Deliverables:

- new create-order path for GA
- updated gRPC client methods
- updated outbox payloads

Dependencies:

- CP-04

Acceptance criteria:

- no order is created without a confirmed reservation
- transaction failure triggers release compensation
- no per-user limit bypass under concurrency

Verification:

- `mvn -q test`
- `mvn -q checkstyle:check`

---

## CP-06 GA End-To-End Verification And Rollout Readiness

- [x] Close the GA quota enhancement loop

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- contract validation across order-service and ticket-service
- migration rehearsal for existing tickets
- local end-to-end flow validation
- operational checklist for deployment order

Deliverables:

- verified local GA purchase flow
- documented migration order
- documented rollback notes

Dependencies:

- CP-05

Acceptance criteria:

- create -> cancel -> re-purchase works
- create -> payment complete -> sold counters correct
- duplicate event replay is harmless

Verification:

- `go test ./...`
- `mvn -q test`
- local smoke flow through Kong if available

---

## CP-07 Venue-Service Scaffold And Persistence Foundation

- [x] Create the `venue-service` skeleton and durable schema

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- scaffold service structure
- config, tracing, logging, health, Dockerfile
- PostgreSQL schema for venues, plans, sections, seats, reservation ledger
- Redis and Kafka bootstrap wiring

Deliverables:

- `services/venue-service/`
- migrations for `venues`, `seating_plans`, `sections`, `price_tiers`, `seats`, `seat_reservations`, `seat_reservation_items`

Dependencies:

- CP-01

Acceptance criteria:

- service boots with validated config
- plan binding supports draft creation without deadlock
- dedicated venue DB assumptions are explicit

Verification:

- `go test ./...` in `services/venue-service` once scaffold exists
- service startup smoke check

---

## CP-08 Venue Template And Seating Plan CRUD

- [x] Implement organizer CRUD for venues and draft plans

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- venue template CRUD
- draft seating plan CRUD
- attach plan to draft ticket
- activate plan validation path

Deliverables:

- draft-first plan lifecycle
- ticket-to-plan attach flow
- organizer validation for ownership

Dependencies:

- CP-07

Acceptance criteria:

- organizer can create ticket first, then attach plan later
- active plans require valid attachment
- ticket-service and venue-service validate ownership consistently

Verification:

- service tests for attach and activation rules

---

## CP-09 Venue Seat Hold And Availability Foundation

- [x] Implement seat hold hot path and SSE-ready state updates

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- cluster-safe Redis key model
- hold and release scripts
- availability snapshot endpoint
- hold sweeper and lazy cleanup

Deliverables:

- public hold API without trusting client-supplied `userId`
- durable + Redis state consistency model
- availability snapshot for client bootstrap

Dependencies:

- CP-08

Acceptance criteria:

- exactly one user can hold a seat at a time
- expired holds are recoverable
- public APIs use authenticated request identity

Verification:

- unit and integration tests for hold contention

---

## CP-10 Venue Seated Reservation Lifecycle

- [x] Implement seated reservation ledger and order-facing gRPC

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- `ReserveHeldSeats`
- `AutoAssignAndReserve`
- `ReleaseSeatReservation`
- `FinalizeSeatReservation`
- reservation ledger persistence and idempotency

Deliverables:

- seated reservation gRPC API
- durable reservation item rows
- idempotent cancel/finalize flows

Dependencies:

- CP-09

Acceptance criteria:

- pre-order reservation does not require `orderId`
- duplicate cancel or complete is harmless
- no seat reservation success is returned before durable write succeeds

Verification:

- unit and integration tests for reserve/release/finalize

---

## CP-11 Venue Auto-Assign And Real-Time Delivery

- [x] Finish auto-assign strategy and SSE delivery path

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- row-based fast path
- contiguous block scoring
- SSE broadcaster with batching and reconnect behavior

Deliverables:

- auto-assign implementation for seated sections
- SSE event stream for seat state changes

Dependencies:

- CP-10

Acceptance criteria:

- auto-assign does not overlap seats under concurrency
- SSE is UX-only, not purchase authority

Verification:

- algorithm tests
- SSE integration tests

---

## CP-12 Order-Service Seated Flow Integration

- [ ] Integrate seated reservations into `order-service`

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- add `OrderSeat` entity and migration
- manual seated purchase flow
- auto-assign seated purchase flow
- compensation on order transaction failure
- enrich order events with `reservationId`, `seatIds`, `quantity`

Deliverables:

- seated order creation flow
- `order_seats` persistence
- updated outbox payloads

Dependencies:

- CP-04
- CP-10

Acceptance criteria:

- one order may contain multiple seats
- manual and auto-assign seated flows both succeed end to end
- seated order failure compensates reservation correctly

Verification:

- `mvn -q test`
- `mvn -q checkstyle:check`

---

## CP-13 Ticket-Service Seated Catalog Integration

- [ ] Add `seatingPlanId` catalog support in `ticket-service`

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- ticket model support for `seatingPlanId`
- ticket response updates
- validation path for attach
- event payload updates for catalog consumers

Deliverables:

- seated ticket metadata in catalog APIs
- explicit behavior split between GA inventory and seated inventory

Dependencies:

- CP-10

Acceptance criteria:

- tickets with `seatingPlanId` are not handled by GA quota reserve path
- attach validation checks plan existence and ownership

Verification:

- `go test ./...`

---

## CP-14 Client And Organizer UI

- [ ] Add user-facing and organizer-facing UI support

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- quantity UI for GA
- seat map viewer and hold interaction
- organizer seating-plan flow
- attendee names input
- sold-out and purchase-limit handling

Deliverables:

- GA quantity purchase UX
- seated manual selection UX
- auto-assign UX
- organizer draft -> attach -> activate UX

Dependencies:

- CP-06
- CP-11
- CP-12
- CP-13

Acceptance criteria:

- UI uses server-validated availability, not client-only assumptions
- hold expiry is handled gracefully
- errors from 409 and 422 paths are clearly shown

Verification:

- `pnpm lint && pnpm tsc --noEmit`

---

## CP-15 Hardening, Reconciliation, Performance, And E2E

- [ ] Finish production hardening across both flows

Owner:

- `Owner: TBD`
- `Reviewers: TBD`

Scope:

- reconciliation workers
- metrics and alerts
- load testing
- contract verification
- Playwright coverage for critical journeys

Deliverables:

- Redis drift correction for GA and seated paths
- dashboards and key alerts
- concurrency/load test evidence
- E2E suite updates

Dependencies:

- CP-12
- CP-13
- CP-14

Acceptance criteria:

- no oversell under target concurrency scenarios
- duplicate event replay remains safe
- SSE and checkout behavior hold under stress

Verification:

- `go test ./...`
- `mvn -q test`
- `pnpm lint && pnpm tsc --noEmit`
- Playwright critical journeys
- load-test reports

---

## 5. Parallelization Guidance

These checkpoints can run in parallel once dependencies are met:

- CP-02 and CP-07 cannot start before CP-01, but can run in parallel after it.
- CP-08 and CP-03 can run in parallel once their foundations are ready.
- CP-11 and CP-12 can overlap after seated reservation contracts stabilize.
- CP-13 can proceed while CP-12 is in progress if the attach contract is stable.
- CP-14 should begin with mock/stub flows only after API contracts stop changing.

---

## 6. Review Strategy

Recommended PR slicing:

1. Contracts first
2. GA inventory foundation
3. GA order integration
4. Venue scaffold and schema
5. Seat holds
6. Seated reservation lifecycle
7. Seated order integration
8. Catalog and client updates
9. Hardening and performance

This keeps each review focused on one architectural concern at a time.

---

## 7. Progress Log

Use this section as lightweight scrum tracking.

| Checkpoint | Status | Owner | PR / Branch | Notes |
|---|---|---|---|---|
| CP-01 | [x] | @agent | PR #17 | `tickets.proto` and new `venue.proto` landed; Go stubs regenerated |
| CP-02 | [x] | @agent | PR #18 | Quota fields + reservation ledger in ticket-service; MongoDB indexes |
| CP-03 | [x] | @agent | PR #19 | Redis Lua scripts for atomic quota reserve/release/finalize |
| CP-04 | [x] | @agent | PR #20 | gRPC RPCs + Kafka consumer for reservation lifecycle |
| CP-05 | [x] | @agent | PR #21 | Order-service GA reservation integration with gRPC + compensation |
| CP-06 | [x] | @agent | PR #24 | 3× E2E lifecycle tests + Kong smoke (AC-1/2/3 all pass); migration/rollback doc added |
| CP-07 | [x] | @agent | PR #25 | venue-service scaffold + 7 migrations + CI job; 5/5 unit + 7/7 integration tests pass |
| CP-08 | [x] | @agent | PR #26 | Venue + plan CRUD repos, REST handlers, wired main.go; 10 unit + 1 integration tests pass |
| CP-09 | [x] | @agent | PR #27 | Redis Lua hold/release scripts, SeatHoldHandler, hold sweeper; 18 unit + 5 integration tests pass |
| CP-10 | [x] | @agent | PR #28 | Seated reservation gRPC RPCs + Kafka handlers + reservation ledger; 21 unit + 5 integration tests pass |
| CP-11 | [x] | @agent | PR #29 | Auto-assign algorithm (row-based + cross-row fallback), AutoAssignAndReserve gRPC, SSE broadcaster + HTTP handler; 8 autoassign unit + 7 gRPC unit + 3 integration tests pass |
| CP-12 | [ ] | TBD |  |  |
| CP-13 | [ ] | TBD |  |  |
| CP-14 | [ ] | TBD |  |  |
| CP-15 | [ ] | TBD |  |  |
