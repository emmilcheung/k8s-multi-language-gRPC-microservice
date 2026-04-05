# Ticketing Feature — Complete Workstream Specification

**Goal:** Implement world-standard ticketing platform with event metadata, flexible pricing, and real payments.

**Total scope:** 11 discrete workstreams (WS1-11, WS9 has 8 sub-tasks = 18 total units)

---

## Workstream Status Summary

| # | Task | Status | Priority |
|---|---|---|---|
| **2** | Plan modes (assignment + pricing) | ✅ Complete | P0 (foundation) |
| **3** | 2-step ticket creation wizard | ✅ Complete | P1 (depends on WS2) |
| **4** | Auto-assign enforcement | ✅ Complete | P1 (depends on WS2) |
| **8** | Event entity (critical missing concept) | ✅ Complete | P0 (independent) |
| **9A** | Ticket card indicators | ✅ Complete | P2 (depends on WS8) |
| **9B** | Server-side availability filter | ✅ Complete | P2 (depends on WS8) |
| **9D** | Venue address field | ✅ Complete | P2 (independent) |
| **9E** | Layout JSON size limit | ✅ Complete | P2 (security, independent) |
| **9F** | GA sections guard | ✅ Complete | P2 (security, independent) |
| **9G** | orderTotal deduplication | ✅ Complete | P3 (polish) |
| **9C** | AWAITING_PAYMENT cleanup | 🔄 In Progress | P2 |
| **9H** | Stripe Elements integration | 🔄 In Progress | P1 (payment flow) |

---

## Detailed Workstream Specs

### Workstream 2 — Plan Modes (assignment_mode + pricing_mode)

**Status:** ✅ Complete

**Problem:** Seating plans have no concept of how seats are assigned (manual buyer selection vs. system auto-pick) or how prices are determined (flat vs. per-section vs. per-seat).

**Solution:** Add two new fields to `seating_plans` table with strict enum validation.

**Files Modified:**
- `services/venue-service/internal/migrations/003_plan_modes.up.sql` — Schema migration
- `services/venue-service/internal/migrations/003_plan_modes.down.sql` — Rollback
- `services/venue-service/internal/repository/repository.go` — SeatingPlan struct
- `services/venue-service/internal/repository/postgres/plan_repo.go` — CRUD queries
- `services/venue-service/internal/handler/plan_handler.go` — HTTP request/response
- `services/venue-service/internal/grpc/server.go` — gRPC GetSeatingPlanResponse
- `libs/grpc-stubs/go/venue/v1/venue.pb.go` — Hand-edited proto stub

**Key Design:**
- `assignment_mode IN ('manual', 'auto')` — Seller controls; defaults to 'manual'
- `pricing_mode IN ('single', 'section', 'seat')` — Defaults to 'single'
- Both fields required with CHECK constraints
- gRPC response includes assignment_mode for backend enforcement

---

### Workstream 3 — 2-Step Ticket Creation Wizard

**Status:** ✅ Complete

**Problem:** Sellers can't specify ticket type or pricing mode; single static form with no flexibility.

**Solution:** Split ticket form into 2-step wizard: Step 1 (type selection) → Step 2 (type-specific fields).

**Files Modified:**
- `services/client/components/ticket-form.tsx` — Complete UI refactor (501 lines)
- `services/client/app/actions/tickets.ts` — Enhanced createTicket action
- `services/ticket-service/internal/repository/mongo_ticket_repository.go` — Add ticketType field
- `services/ticket-service/internal/handler/ticket_handler.go` — Include ticketType in responses
- `services/ticket-service/internal/service/ticket_service.go` — Set ticketType on plan attachment

**Key Design:**
- Step 1: Radio group (GA | Manual Seating | Auto Seating)
- Step 2A (GA): Title, Price, Quota, MaxPerUser
- Step 2B (Seated): Title, Plan picker, Pricing mode selector, dynamic price fields
- TicketType lazy-assigned when plan attached (not at creation)

---

### Workstream 4 — Auto-Assign Enforcement

**Status:** ✅ Complete

**Problem:** Buyer toggle on SeatMapClient overrides seller's choice; backend doesn't validate.

**Solution:** Remove buyer toggle; backend validates mode on order creation.

**Files Modified:**
- `services/client/components/seat-map-client.tsx` — Remove toggle; add assignmentMode prop
- `services/client/app/tickets/[ticketId]/seats/page.tsx` — Pass plan.assignmentMode
- `services/order-service/.../OrderService.java` — Validation in createSeatedOrder
- `services/order-service/.../VenueServiceClient.java` — Fetch plan metadata

**Key Design:**
- Defense in depth: UI removal + backend validation
- Manual mode: Seat grid shown; buyer clicks to select
- Auto mode: Section dropdown + quantity stepper; system picks best available
- Backend rejects explicit seatIds on auto plans; rejects no seatIds on manual plans

---

### Workstream 8 — Event Entity (Critical Missing Concept)

**Status:** ✅ Complete

**Problem:** Tickets have no event metadata (date, time, venue, description, image). Buyers see only title + price.

**Solution:** Add Event sub-document to Ticket; denormalize venue name/address to avoid cross-service joins.

**Files Modified:**
- `services/ticket-service/internal/repository/mongo_ticket_repository.go` — Add TicketEvent struct + Event field
- `services/ticket-service/internal/service/ticket_service.go` — Validate event.startsAt required
- `services/ticket-service/internal/handler/ticket_handler.go` — Accept event in request; include in response
- `services/ticket-service/internal/kafka/producer.go` — Include event data in Kafka payloads
- `libs/grpc-stubs/go/tickets/v1/tickets.pb.go` — Add 6 event fields to GetTicketResponse

**Key Design:**
- Event fields: title, description, startsAt (required), endsAt, imageURL, venueName (denormalized), venueAddress (denormalized)
- Backward compatible: Existing tickets have Event=nil
- Kafka event publishing includes event data for order-service replication
- Denormalization avoids join on every ticket list read

---

### Workstream 9A — Ticket Card Visual Indicators

**Status:** ✅ Complete

**Problem:** Ticket grid cards show only title + price; buyers have no visibility into event dates or availability.

**Solution:** Add three visual indicators to each card.

**Files Modified:**
- `services/client/components/ticket-grid.tsx` — Enhanced TicketCard component
- `services/client/lib/types.ts` — Ticket interface (if needed)

**Key Design:**
- Event date badge (e.g., "Apr 4, 2026") from ticket.event.startsAt
- Ticket type icon + label: GA (bag), Manual (chair), Auto (lightning)
- GA availability count: "X remaining" = quota - sold (only for GA)
- Graceful handling of null/missing event

---

### Workstream 9B — Server-Side Availability Filter

**Status:** ✅ Complete

**Problem:** Client-side filtering of sold-out tickets causes stale data; buyers see unavailable tickets.

**Solution:** Add server-side filtering with `?available=true` query parameter.

**Files Modified:**
- `services/client/app/actions/tickets.ts` → fetchTicketPage() — Add available=true param
- `services/ticket-service/internal/handler/ticket_handler.go` → ListTickets() — Filter sold-out tickets

**Key Design:**
- Frontend: Add `?available=true` to GET /api/tickets
- Backend: Filter GA tickets where sold < quota; filter seated plans with available seats
- Backward compatible: Omitting param returns all tickets

---

### Workstream 9C — AWAITING_PAYMENT Status Cleanup

**Status:** 🔄 In Progress

**Problem:** AWAITING_PAYMENT status enum exists but no code path sets it; order state machine undefined.

**Solution:** Wire state machine: CREATED → AWAITING_PAYMENT → PAID → COMPLETED.

**Files to Modify:**
- `services/order-service/src/main/java/com/ticketing/orders/service/OrderService.java` — submitPayment handler
- `services/order-service/src/main/java/com/ticketing/orders/controller/OrderController.java` or webhook handler — Payment state transition
- `services/client/app/orders/[orderId]/page.tsx` — Update stepper with real states

**Key Design:**
- submitPayment creates PaymentIntent; transitions order to AWAITING_PAYMENT
- Stripe webhook payment_intent.succeeded → transitions to PAID
- Order detail page shows accurate real-time state

---

### Workstream 9D — Venue Address Field

**Status:** ✅ Complete

**Problem:** Venues have no address; ticket listings can't show where events are.

**Solution:** Add address field to venues table.

**Files Modified:**
- `services/venue-service/internal/migrations/004_venue_address.up.sql` — Add address column
- `services/venue-service/internal/migrations/004_venue_address.down.sql` — Rollback
- `services/venue-service/internal/repository/repository.go` — Venue struct
- `services/venue-service/internal/repository/postgres/venue_repo.go` — CRUD
- `services/venue-service/internal/handler/venue_handler.go` — Request/response

**Key Design:**
- address TEXT, DEFAULT '' (optional in requests; defaults to empty)
- Integrated into all venue CRUD operations

---

### Workstream 9E — Layout JSON Size Limit (Security)

**Status:** ✅ Complete

**Problem:** No validation on layoutJSON; organizer could store MBs of data, exhausting storage.

**Solution:** Add 1 MB size check on plan layout endpoints.

**Files Modified:**
- `services/venue-service/internal/handler/plan_handler.go` → SaveLayout() handler

**Key Design:**
- Check: `if len(req.LayoutJSON) > 1_048_576 { return 422 }`
- Placed before database operations
- Error message: "layout JSON exceeds 1 MB limit"

---

### Workstream 9F — GA Sections Guard (Validation)

**Status:** ✅ Complete

**Problem:** GA (general admission) sections can be mixed into section/seat pricing plans, creating confusion.

**Solution:** Block GA sections on activation unless plan is single-price.

**Files Modified:**
- `services/venue-service/internal/handler/plan_handler.go` → Activate() handler

**Key Design:**
- Validation: If pricingMode != 'single', reject any GA sections
- Check happens during plan activation
- Error message: "GA sections are not allowed in section/seat pricing plans. Create a separate GA ticket instead."

---

### Workstream 9G — orderTotal Deduplication

**Status:** ✅ Complete

**Problem:** orderTotal() function duplicated across two order pages.

**Solution:** Extract to shared utility.

**Files Modified:**
- `services/client/lib/order-utils.ts` — New shared utility file
- `services/client/app/orders/page.tsx` — Import calculateOrderTotal
- `services/client/app/orders/[orderId]/page.tsx` — Import calculateOrderTotal

**Key Design:**
- Shared function: calculateOrderTotal(order) → sum of (quantity × price) + fees
- Both pages import and use centralized function

---

### Workstream 9H — Stripe Elements Real Payment UI

**Status:** 🔄 In Progress

**Problem:** Stub "Pay Now" button uses hardcoded test payment method (pm_card_visa).

**Solution:** Integrate Stripe Payment Element for real card collection.

**Files to Modify:**
- `services/client/components/order-payment-form.tsx` — Complete UI rewrite
- `services/client/lib/stripe-utils.ts` — Helper functions (create if needed)

**Key Design:**
- Load Stripe.js with publishable key from environment
- Render Payment Element for card input
- On submission: Confirm payment with Stripe; get real paymentMethodId
- Pass real paymentMethodId to backend submitPayment action
- Error handling: Show validation + network errors gracefully
- Test with Stripe test cards: 4242 4242 4242 4242 (success), 4000 0000 0000 0002 (decline)

---

## Execution Order (Dependency-Aware Batching)

**Batch 1 (Foundation):**
- WS2 (schema + gRPC)

**Batch 2 (Depends on WS2):**
- WS4 (enforcement)
- WS3 (form)

**Batch 3 (Independent):**
- WS8 (event entity)

**Batch 4 (Depends on WS8):**
- WS9A, 9B (can parallelize; depend on WS8)
- WS9D, 9G (independent; can parallelize)
- WS9E, 9F (security fixes; independent; can parallelize)

**Batch 5 (Final):**
- WS9C (status cleanup; independent)
- WS9H (payment UI; independent but typically last due to complexity)

---

## Test Verification Checklist

For each completed workstream, verify:

- [ ] Go tests pass: `go test ./...` (venue-service, ticket-service)
- [ ] TypeScript: `pnpm tsc --noEmit` (no errors)
- [ ] Linting: `pnpm lint` (no new errors)
- [ ] Build: `pnpm build` or `go build ./...` (succeeds)
- [ ] Key business logic: Create test data and verify behavior end-to-end

---

## Dependency Graph

```
WS2 (schema + modes)
  ↓
┌─────────────────┐
│                 │
WS4 (enforcement) WS3 (form)
│                 │
└─────────────────┘ (both depend on WS2)
        ↓
WS8 (event entity) — independent, can run parallel to WS3/4
        ↓
┌──────────────────────────────────────┐
│ WS9A  WS9B  WS9D  WS9E  WS9F  WS9G  │ (all independent; can parallelize)
└──────────────────────────────────────┘
        ↓
WS9C (status cleanup) + WS9H (payment UI) — independent, can parallelize
```

---

## For Coordinators: Quick Dispatch Reference

### How to Prompt an Agent for a Workstream

Use this template; fill in from the spec above:

```
Workstream {#} — {Name}

TASK: {One-line summary}

PROBLEM: {Why this matters}

FILES TO MODIFY:
- {path} — {section}
- {path} — {section}

IMPLEMENTATION:
{Detailed steps from spec}

VERIFICATION:
{Test cases}

FOCUS: {What NOT to over-engineer}
```

### Parallel Dispatch Pattern

```python
Agent(...WS9D...), Agent(...WS9E...), Agent(...WS9F...), Agent(...WS9G...)
# All run in parallel since independent
```

### Sequential Dispatch Pattern

```python
Agent(...WS2...)  # Wait for completion

Agent(...WS3...), Agent(...WS4...)  # Now safe to parallelize; depend on WS2
# Wait for completion

Agent(...WS8...)  # Independent; can run while WS3/4 finishing
```

---

## Historical Notes

- **WS1, 5-7:** Completed in earlier sessions (hold TTL, price fallback, capacity validation, order timer)
- **WS2-4, 8:** Completed; tested; all tests passing
- **WS9A-9G:** Completed; all tests passing
- **WS9C, 9H:** Final workstreams; in progress

See `TICKETING_STATUS.md` for session-by-session progress.
