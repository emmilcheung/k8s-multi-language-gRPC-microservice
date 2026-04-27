# Seating Plan Ownership Strategy — Investigation & Recommendation

**Status:** Investigation complete — ready for brainstorming  
**Date:** 2026-04-27  
**Scope:** SeatingPlan ownership model: venue-owned vs ticket-owned  

---

## 1. Current State (Evidence from Code)

### 1.1 Ownership Coupling: SeatingPlan ↔ Venue

The `seating_plans` table has a hard FK to `venues`:

```sql
-- 001_schema.up.sql:46
venue_id UUID NOT NULL REFERENCES venues (id)
```

No `ON DELETE CASCADE` — the FK prevents venue deletion if plans exist, but does not cascade.

The SeatingPlan struct carries `VenueID` as a required field, and the `Create` handler enforces it:

```go
// plan_handler.go:116
if req.VenueID == "" {
    return c.JSON(http.StatusUnprocessableEntity, errorResponse("venueId is required"))
}
```

API paths are plan-centric (`/api/seating-plans`), but all list queries are filtered by `venueId`:

```go
// plan_handler.go:86
plans, err := h.planRepo.ListByVenue(c.Request().Context(), venueID, organizerID)
```

The `ticket_id` column on `seating_plans` is **nullable** — the plan exists independently of any ticket until `AttachTicket` is called. This creates the indirect coupling: a plan is born under a venue, then later linked to a ticket.

### 1.2 Reuse: One Venue → Many Plans

`ListByVenue` returns all plans for a venue. The client UI at `/venues/[venueId]/page.tsx` lists them. The `fetchAllMyPlans()` function iterates all venues and collects plans per venue — this is used to populate the "attach plan" dropdown on the ticket creation page.

**Is reuse exercised?** Yes, structurally. The UI path `venues/[venueId]/plans/new` creates a new plan each time. Each plan auto-provisions sections from the venue template via `ProvisionFromVenue`. So a venue can produce many plans (one per event at that venue). This is the correct reuse model — venue templates are cloned, not shared.

No code path shares a single `SeatingPlan` row across multiple tickets. The relationship is 1:1 (one plan → one ticket) once attached.

### 1.3 Lifecycle: draft → active → inactive

- `draft`: plan is being configured. Layout, sections, pricing, and seat inventory can be edited.
- `active`: plan is live. Seat holds and purchases are permitted. Requires `ticket_id` to be set and at least one section to exist.
- `inactive`: plan is decommissioned. No new holds/purchases.

The lifecycle is enforced by the `Activate` handler:
- Must have at least one section with capacity > 0
- Transitions require optimistic concurrency (version field)

The activation precondition (plan attached to a ticket) is implicit in the design doc (§4.3) but **not currently enforced in code** — the `Activate` handler does not check for `ticket_id != NULL`. This is a gap.

### 1.4 Seat Inventory: Per-Plan, Not Per-Venue

The `seats` table FKs to `sections` and `seating_plans`:

```sql
section_id UUID NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
plan_id    UUID NOT NULL REFERENCES seating_plans (id) ON DELETE CASCADE,
```

Seat state machine (AVAILABLE → HELD → RESERVED → SOLD) is plan-scoped. The hold manager keys Redis by `{planId}`. Nothing references the venue at runtime for seat operations. The venue is only relevant at provisioning time.

### 1.5 Cross-Service Interaction

**ticket-service → venue-service:** gRPC `GetSeatingPlan` call during `AttachSeatingPlan` to fetch `assignmentMode` and denormalize it as `ticketType` on the ticket.

**venue-service → ticket-service:** No direct dependency. The venue-service `seat_reservations` table stores `ticket_id` for the reservation ledger, but this is a loose reference (no FK to ticket-service's MongoDB).

**Client coordination (tickets.ts:165-185):** On ticket creation with a seated type, the client makes **two separate attach calls**:
1. `PUT /api/tickets/:id/seating-plan` (ticket-service)
2. `POST /api/seating-plans/:id/attach-ticket` (venue-service)

This dual-write is the core UX problem — it's fragile, requires two services to agree, and can leave the system in a half-attached state if either fails.

---

## 2. Analysis of the Five Questions

### Q1: How tightly is SeatingPlan coupled to Venue?

**Answer: Structurally tight, operationally loose.**

- **Tight:** Hard FK `venue_id NOT NULL REFERENCES venues(id)` — plan cannot be created without a venue.
- **Tight:** API list endpoint requires `?venueId=` query param — no way to list plans by ticket.
- **Tight:** Client navigation is venue-first (`/venues/[id]/plans/[id]`).
- **Loose:** At runtime (holds, reservations, SSE, purchase flows), the venue is never consulted. All operations are plan-scoped. Redis keys are `{planId}:`-tagged.

Moving ownership to ticket would require:
- Making `venue_id` nullable (or adding `ticket_id NOT NULL` as the primary owner FK)
- Adding list-by-ticket API endpoint (already exists: `ListByTicket`)
- Changing the client's navigation and creation flow

### Q2: Is multi-plan-per-venue reuse exercised?

**Answer: Yes, and it's the correct model.**

Each event at a venue creates a new plan. The venue templates (`venue_sections`) act as blueprints that are cloned into plan-scoped `sections` rows by `ProvisionFromVenue`. This clone-at-creation pattern means the venue → plan relationship is 1:N (one venue, many events, many plans).

In a ticket-owned model, reuse works as: "Create a new plan for this ticket by cloning from a venue template." This is already how it works — the `venueId` parameter tells `ProvisionFromVenue` which template to clone from. The venue does not need to be the FK owner for cloning to work.

### Q3: Does the lifecycle fit better on per-venue or per-ticket?

**Answer: Per-ticket is the natural fit.**

- A plan becomes meaningful only when attached to a ticket (an event).
- Plan activation should be gated on ticket attachment (the design doc says so, code doesn't enforce it yet).
- When a ticket is cancelled, the plan should deactivate (releasing all holds). Today this requires a manual deactivate call because there's no ownership cascade.
- The `draft → active` transition logically means "this event's seating is open for purchase" — that's a per-event lifecycle, not per-venue.

The current model forces users through a venue-centric workflow for an event-centric operation. The design doc (§4.1) already acknowledges the "creation deadlock" problem and the need to attach a ticket before activation.

### Q4: Does moving ownership change seat hold/purchase mechanics?

**Answer: No. It's transparent.**

All seat operations (hold, reserve, sell, SSE) are keyed by `planId`. The hold manager, reservation repository, auto-assign, and Redis layer never look at `venue_id`. The `venue_id` column is only used at creation time (provisioning) and in the list-by-venue query.

Moving ownership to ticket changes the parent relationship and the list endpoint, but does not touch the hot path.

### Q5: Should venue-service still own SeatingPlan if it becomes ticket-owned?

**Answer: Yes. venue-service should keep the SeatingPlan entity.**

Rationale:
- venue-service owns the seat inventory, holds, reservations, and real-time availability — these are tightly coupled to the plan.
- Moving SeatingPlan to ticket-service would require ticket-service (a MongoDB service) to manage a Postgres schema with Redis seat state, SSE broadcasting, etc. This violates the "own data" rule and massively increases ticket-service's scope.
- The "owned by ticket" relationship is a logical ownership concept (the plan is for this ticket/event), not a service ownership change. The FK reference to `ticket_id` already implements this.

The correct model: ticket-service stores `seatingPlanId` on the ticket document (pointer). venue-service stores the plan, sections, seats, holds, and reservations. The plan's `ticket_id` FK is the back-pointer. **Logical ownership is ticket-centric; service ownership stays in venue-service.**

---

## 3. Proposed Model

```
                                    ticket-service (MongoDB)
                                    ┌───────────────────────┐
                                    │  Ticket               │
                                    │    seatingPlanId ──────┼─── pointer to plan
                                    │    ticketType         │
                                    └───────────────────────┘
                                              │
                                              │ gRPC GetSeatingPlan (validation)
                                              ▼
venue-service (PostgreSQL)
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Venue ──has──▶ VenueSection (reusable template)                    │
│                      │                                               │
│                      │ ProvisionFromVenue (clone at plan creation)   │
│                      ▼                                               │
│  SeatingPlan ◀──creates── createPlanForTicket(ticketId, venueId)    │
│    ticket_id NOT NULL (FK to nowhere, logical owner)                 │
│    venue_id  NOT NULL (source template reference)                    │
│    ─── Sections ─── Seats ─── PriceTiers                            │
│    ─── SeatReservations ─── SeatReservationItems                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key change:** The plan is created *with* `ticketId` from the start. The `venueId` is retained as a template source reference (not removed), but is no longer the primary organizational axis.

---

## 4. What Changes

### 4.1 venue-service API

| Current | Proposed | Notes |
|---------|----------|-------|
| `POST /api/seating-plans` with `{venueId, name}` | `POST /api/seating-plans` with `{ticketId, venueId, name}` | `ticketId` required at creation; no separate attach step |
| `POST /api/seating-plans/:id/attach-ticket` | **Remove** | Ticket binding happens at creation |
| `GET /api/seating-plans?venueId=X` | `GET /api/seating-plans?ticketId=X` (primary), keep `?venueId=X` (secondary for template browsing) | Ticket-centric listing becomes default |
| `POST /api/seating-plans/:id/activate` | Same — but enforce `ticket_id IS NOT NULL` (already true by construction) | Simplification |

### 4.2 venue-service Database

```sql
-- Migration: make ticket_id NOT NULL with default enforcement at app level
-- For new plans, ticket_id is required at creation.
-- Existing plans with NULL ticket_id get a backfill or remain as legacy draft.
ALTER TABLE seating_plans ALTER COLUMN ticket_id SET NOT NULL;
-- Add index for primary lookup pattern
CREATE INDEX idx_seating_plans_ticket_id_status ON seating_plans (ticket_id, status);
```

### 4.3 venue-service Go Code

| File | Change |
|------|--------|
| `handler/plan_handler.go` | `Create`: require `ticketId` in request body. Remove `AttachTicket` endpoint entirely. |
| `repository/repository.go` | `SeatingPlan.TicketID`: remove "empty until attached" comment. `PlanRepository`: remove `AttachTicket` method. |
| `repository/postgres/plan_repo.go` | Remove `AttachTicket` SQL. Update `Create` to require `ticket_id`. |

### 4.4 ticket-service Changes

| File | Change |
|------|--------|
| `handler/ticket_handler.go` | Remove `AttachSeatingPlan` / `DetachSeatingPlan` endpoints (or keep detach for edge cases). |
| `repository/mongo_ticket_repository.go` | Remove `AttachSeatingPlan` / `DetachSeatingPlan` methods. Instead, set `seatingPlanId` during ticket creation or via a simple field update. |
| `service/ticket_service.go` | Remove `AttachSeatingPlan` / `DetachSeatingPlan` service methods. |

### 4.5 Client Changes

| File | Change |
|------|--------|
| `app/actions/tickets.ts` | `createTicket`: After creating ticket, create the plan in venue-service with `ticketId` in one step (no dual-write). |
| `app/actions/venues.ts` | Remove `activatePlan`, `deactivatePlan` from venue-centric flow. These move to ticket detail. |
| `app/venues/[venueId]/plans/` | Simplify to "template preview" — no plan creation from venue pages. |
| `app/tickets/[ticketId]/page.tsx` | Plan creation and management inline on the ticket page. |
| `components/attach-seating-plan-form.tsx` | Replace with "Create seating plan" inline form on ticket detail. |

---

## 5. What Stays the Same

| Component | Why it doesn't change |
|-----------|----------------------|
| `Venue` entity + `VenueSection` templates | Still the reusable layout blueprint. Organizers define venue structure once. |
| `ProvisionFromVenue` mechanism | Still clones venue templates into plan-scoped sections. The `venueId` param remains required. |
| `Section`, `Seat`, `PriceTier` tables | Still plan-scoped. No structural change. |
| `SeatReservation` + `SeatReservationItem` | Still plan-scoped. `ticket_id` on reservations stays the same. |
| Hold manager (Redis hot path) | Keyed by `planId` — unchanged. |
| SSE broadcaster | Keyed by `planId` — unchanged. |
| gRPC contract (ReserveHeldSeats, etc.) | Already takes `plan_id` + `ticket_id` — unchanged. |
| GraphQL federation entity (`SeatingPlan`) | Resolved by `planId` — unchanged. |
| `order-service` integration | Orders reference `reservationId` → `plan_id` — unchanged. |

---

## 6. Reuse Strategy

**How an organizer reuses a layout across events:**

1. Organizer defines a `Venue` with `VenueSections` (rows, columns, capacity per section). This is a one-time setup.
2. For each new event (ticket), the organizer creates a plan and selects the venue. `ProvisionFromVenue` clones the template.
3. The organizer customizes the cloned plan: block seats, adjust tiers, change section names for this specific event.
4. No plan row is ever shared between tickets. Each event gets its own inventory.

**UI flow (proposed):**

```
Ticket creation form → select type "Seated" → pick venue (dropdown) →
plan auto-created with cloned sections → configure sections/pricing →
activate → event goes live
```

This collapses the current 5-step flow into a single ticket-centric workflow.

---

## 7. Migration Path

### Existing Data

| Scenario | Strategy |
|----------|----------|
| Plans with `ticket_id IS NOT NULL` | Already correct — no change needed. |
| Plans with `ticket_id IS NULL` (draft, never attached) | Mark as `inactive` or leave as orphans. These are incomplete drafts that were never used. |
| Plans with `ticket_id IS NULL` but `status = 'active'` | Should not exist (activation should require attachment). If any do exist, they're invalid state — investigate and fix manually. |

### Migration SQL

```sql
-- Step 1: Deactivate orphaned active plans (should be zero rows)
UPDATE seating_plans SET status = 'inactive'
WHERE ticket_id IS NULL AND status = 'active';

-- Step 2: Add NOT NULL constraint with a sentinel for legacy orphans
-- Option A: backfill orphans to a sentinel UUID, then add constraint
-- Option B: add NOT NULL on new rows only (app-level enforcement)
-- Recommend Option B for zero-downtime: validate at app level, add DB
-- constraint after all legacy orphans are cleaned up.
```

### Client references

Existing `seatingPlanId` on ticket documents in MongoDB remain valid — the plan IDs don't change, only the creation flow does.

---

## 8. What We'd NOT Change (Scope Boundaries)

- **Venue entity:** Not touched. Still exists for template management.
- **venue-service as the seat inventory owner:** Not moving plans to ticket-service.
- **Redis/PostgreSQL dual-write architecture:** Not simplifying.
- **SSE real-time model:** Not changing to WebSocket.
- **gRPC contract with order-service:** Not redesigning purchase flow.
- **GA quota path in ticket-service:** Completely unrelated.
- **Kafka event schema:** Not adding new events for this change.
- **GraphQL federation:** `SeatingPlan` entity resolver stays in venue-service.

---

## 9. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Dual-write removal leaves half-attached state for in-flight requests during rollout | Medium | Deploy venue-service (accept `ticketId` at creation) first. Keep `AttachTicket` alive as deprecated endpoint for one release cycle. Client switches to new flow. Remove `AttachTicket` after migration complete. |
| `ticket_id NOT NULL` migration fails on existing NULL rows | Low | App-level enforcement first. DB constraint after cleanup sweep. |
| Breaking change to `POST /api/seating-plans` request body | Medium | Add `ticketId` as optional field first (backward-compatible). Make required in next release. |
| Venue pages lose plan management capability | Low | Keep venue pages as "template editor" only. Plan creation moves to ticket context. Add "plans using this venue" read-only list for visibility. |

---

## 10. Summary Recommendation

**Move SeatingPlan's logical ownership from venue-centric to ticket-centric** by requiring `ticketId` at plan creation time and eliminating the separate attach step.

The venue remains the template source (for `ProvisionFromVenue`), and venue-service remains the service owner of the SeatingPlan entity. The change is primarily about the creation flow and the UX mental model: plans are per-event resources, not per-venue resources.

This fix:
- Eliminates the fragile dual-write attach flow
- Removes the multi-step venue-first workflow that confused users
- Enforces the invariant that every plan belongs to a specific event
- Preserves all existing runtime behavior (holds, purchases, reservations)
- Is backward-compatible with a phased migration

---

## 11. Objectives That Must Not Be Misunderstood

These are the goals that an implementing agent is most likely to get wrong. Read these as hard constraints:

### The Actual Goal

> **Collapse the multi-step creation flow into a single ticket-centric operation.** The user creates a ticket, picks a venue (for the template), and gets a plan — in one workflow. No separate "create plan at venue, then attach to ticket" dance.

### Common Misinterpretations (Anti-Goals)

| What an agent might think | What we actually mean |
|---------------------------|----------------------|
| "Move `SeatingPlan` table to ticket-service" | **NO.** venue-service keeps the table, the Postgres DB, all seat logic. Only the _creation flow_ changes. |
| "Remove `venue_id` from `seating_plans`" | **NO.** `venue_id` stays. It's the template source. `ProvisionFromVenue` still needs it. |
| "Tickets now manage seat inventory" | **NO.** ticket-service never touches seats. venue-service owns holds, reserves, sells. |
| "Rewrite the hold/reserve/purchase path" | **NO.** Those paths are plan-scoped and don't change at all. |
| "Remove the Venue entity or venue pages" | **NO.** Venues are still managed. They're where organizers define reusable templates (sections, rows, columns). |
| "Add a new service for seating" | **NO.** No new services. |
| "Change Redis key layout" | **NO.** Keys are `{planId}:`-scoped — stays the same. |

### The Minimal Mechanical Changes

1. `POST /api/seating-plans` accepts `ticketId` at creation (no separate attach step)
2. Remove `POST /api/seating-plans/:id/attach-ticket` endpoint
3. Remove `PUT /api/tickets/:id/seating-plan` and `DELETE /api/tickets/:id/seating-plan` endpoints (or deprecate)
4. Client creates plan-with-ticket in one action instead of two sequential API calls
5. Client moves plan configuration UI from `/venues/[id]/plans/[id]` to `/tickets/[id]` context

That's it. Everything else (venue templates, seat state machines, holds, reservations, Redis, SSE, gRPC, GraphQL, order-service) is untouched.

---

## 12. Agent Implementation Prompt

Use this prompt to instruct an agent to implement this plan. Copy it verbatim.

---

```
You are implementing a specific architectural change to a microservices ticketing platform.
The spec is at: docs/superpowers/specs/seating-plan-strategy-investigation.md — read it first.

## What you are doing

You are changing the SeatingPlan creation flow from "venue-first" to "ticket-first."

BEFORE: Organizer goes to venue page → creates plan → configures it → attaches it to a ticket (two services, two API calls, fragile dual-write).

AFTER: Organizer creates a ticket → selects a venue as template source → plan is created with ticketId already set (one API call to venue-service, one field update on ticket-service).

## Critical constraints (violating any of these means you failed)

1. SeatingPlan table STAYS in venue-service Postgres. Do NOT move it to ticket-service.
2. venue_id column STAYS on seating_plans. It is the template source. Do NOT remove it.
3. The hold manager, Redis seat state, SSE broadcaster, gRPC reservation contract, and
   auto-assign algorithm are UNCHANGED. Do not touch files in hold/, sse/, grpc/server.go,
   autoassign/, reconciler/, or the reservation repository.
4. The Venue entity and VenueSection templates are UNCHANGED. Organizers still manage
   venue layouts at /venues/[id].
5. ProvisionFromVenue still clones venue_sections into plan-scoped sections at plan
   creation time. This mechanism is unchanged.
6. No new services, no new databases, no new Kafka topics.

## Phased implementation order

Phase 1 — venue-service backend:
  - Modify POST /api/seating-plans to accept ticketId in the request body (required for new plans).
  - Deprecate POST /api/seating-plans/:id/attach-ticket (keep for one release, log warning).
  - Add GET /api/seating-plans?ticketId=X as the primary list endpoint.
  - Enforce ticket_id NOT NULL at app level in Create handler.
  - Update plan_handler.go, repository interfaces, and postgres plan_repo.go.

Phase 2 — ticket-service backend:
  - Deprecate PUT /api/tickets/:id/seating-plan endpoint.
  - In createTicket flow: after ticket is created, the CLIENT (not ticket-service) calls
    venue-service to create the plan with ticketId.
  - ticket-service still stores seatingPlanId on the ticket doc — but it gets set by a
    simple field update after plan creation succeeds, not via a dedicated "attach" endpoint.

Phase 3 — client:
  - Rewrite ticket creation form: when user picks "Seated" type and selects a venue,
    the form creates the ticket first, then calls POST /api/seating-plans with
    {ticketId, venueId, name} in one step.
  - Move plan configuration UI (sections, pricing, layout editor) to /tickets/[id] context.
  - Keep /venues/[id] as a template-only management page (sections editor, no plan creation).
  - Remove the "Attach seating plan" dropdown from ticket detail.

Phase 4 — cleanup:
  - Migration: UPDATE seating_plans SET status='inactive' WHERE ticket_id IS NULL AND status='active';
  - Remove deprecated attach-ticket endpoint.
  - Remove deprecated PUT /api/tickets/:id/seating-plan endpoint.
  - Add ALTER TABLE seating_plans ALTER COLUMN ticket_id SET NOT NULL after confirming no NULLs remain.

## How to verify your output matches the target

After each phase, run these checks:

### Phase 1 verification
- [ ] `POST /api/seating-plans` with `{venueId, ticketId, name}` creates a plan with ticket_id set
- [ ] `POST /api/seating-plans` WITHOUT ticketId returns 422
- [ ] `GET /api/seating-plans?ticketId=<uuid>` returns plans for that ticket
- [ ] Existing tests for hold/reserve/sell still pass unchanged
- [ ] `ProvisionFromVenue` still clones venue_sections into plan sections
- [ ] No changes to hold/, sse/, grpc/server.go, autoassign/, reconciler/ directories

### Phase 2 verification
- [ ] ticket-service still stores seatingPlanId on ticket documents
- [ ] GA quota reservation path still refuses seated tickets (ErrSeatedTicket)
- [ ] gRPC GetSeatingPlan still works (ticket-service → venue-service)
- [ ] No changes to reservation methods or quota manager

### Phase 3 verification
- [ ] Creating a seated ticket from the UI creates the plan in one action (no dual-write)
- [ ] Venue pages still show template sections (editable) but do NOT create plans
- [ ] Ticket detail page shows plan configuration (sections, pricing, layout)
- [ ] Existing E2E tests for GA ticket creation still pass
- [ ] The seat map at /tickets/[id]/seats still loads and works

### Phase 4 verification
- [ ] No rows remain with ticket_id IS NULL and status = 'active'
- [ ] NOT NULL constraint applies to seating_plans.ticket_id
- [ ] Removed endpoints return 404 or are not registered

### Global invariants (must hold at ALL times)
- [ ] `pnpm lint && pnpm tsc --noEmit` passes in services/client
- [ ] `go vet ./...` passes in services/venue-service and services/ticket-service
- [ ] Existing hold/reserve/purchase E2E tests pass without modification
- [ ] Redis key layout is unchanged ({planId}: prefix)
- [ ] No new services, no new Kafka topics, no new databases
```

---

## 13. Why This Framing Matters

The plan can be misread as "decouple plan from venue" when it actually means "make ticket the entry point for plan creation." The venue relationship is preserved — it's just no longer the _navigational_ or _creation-time_ owner.

An agent that starts by removing `venue_id` or modifying the reservation flow has fundamentally misread the goal. The verification checklists above catch this early: if hold/reserve tests break, or if `ProvisionFromVenue` stops working, the agent has gone off-track.
