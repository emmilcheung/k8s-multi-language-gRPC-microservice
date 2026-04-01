package integration_test

// lifecycle_e2e_test.go — CP-06 acceptance criteria
//
// These tests exercise the full GA reservation lifecycle end-to-end through the
// repository layer, providing explicit evidence for the three CP-06 acceptance
// criteria:
//
//  AC-1  create → cancel → re-purchase works
//  AC-2  create → payment complete → sold counters correct
//  AC-3  duplicate event replay is harmless
//
// Each test spins up its own MongoDB container (single-node replica set) via
// Testcontainers and is guarded by testing.Short() so the CI integration step
// runs them but the unit-only short mode skips them.

import (
	"context"
	"testing"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─── AC-1: create → cancel → re-purchase ─────────────────────────────────────

// TestGA_E2E_CancelAndRepurchase verifies that after buyer-1 cancels their
// reservation the inventory is fully restored so that buyer-2 can purchase
// the same units.
//
// Flow:
//  1. Seed ticket (quota=2, maxPerUser=2).
//  2. buyer-1 reserves 2 units → reserved=2.
//  3. buyer-1 cancels (ReleaseReservation) → reserved=0, status=RELEASED.
//  4. buyer-2 reserves 2 units → reserved=2 (inventory was fully restored).
func TestGA_E2E_CancelAndRepurchase(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "e2e-ticket-ac1", "seller-1", "Cancel & Repurchase Show", 2, 2)

	// Step 1 – buyer-1 reserves 2 units.
	res1 := &repository.TicketReservation{
		ID:       "e2e-res-ac1-buyer1",
		TicketID: "e2e-ticket-ac1",
		UserID:   "e2e-buyer-1",
		Quantity: 2,
	}
	require.NoError(t, repo.CreateReservation(ctx, res1), "buyer-1 reservation should succeed")

	ticket, err := repo.FindByID(ctx, "e2e-ticket-ac1")
	require.NoError(t, err)
	assert.Equal(t, 2, ticket.Reserved, "reserved should be 2 after buyer-1 reserves")
	assert.Equal(t, 0, ticket.Sold, "sold should still be 0")

	// Step 2 – buyer-1 cancels.
	require.NoError(t, repo.ReleaseReservation(ctx, "e2e-res-ac1-buyer1"), "release should succeed")

	released, err := repo.FindReservationByID(ctx, "e2e-res-ac1-buyer1")
	require.NoError(t, err)
	assert.Equal(t, repository.ReservationStatusReleased, released.Status, "reservation should be RELEASED")

	ticket, err = repo.FindByID(ctx, "e2e-ticket-ac1")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved, "reserved should drop back to 0 after cancel")
	assert.Equal(t, 0, ticket.Sold, "sold should remain 0")

	// Step 3 – buyer-2 re-purchases; must succeed because inventory was restored.
	res2 := &repository.TicketReservation{
		ID:       "e2e-res-ac1-buyer2",
		TicketID: "e2e-ticket-ac1",
		UserID:   "e2e-buyer-2",
		Quantity: 2,
	}
	require.NoError(t, repo.CreateReservation(ctx, res2), "buyer-2 re-purchase should succeed after cancel")

	ticket, err = repo.FindByID(ctx, "e2e-ticket-ac1")
	require.NoError(t, err)
	assert.Equal(t, 2, ticket.Reserved, "reserved should be 2 after buyer-2 re-purchase")
	assert.Equal(t, 0, ticket.Sold, "sold still 0 — payment not yet captured")
}

// ─── AC-2: create → payment complete → sold counters correct ─────────────────

// TestGA_E2E_PaymentComplete_SoldCountersCorrect verifies that after payment is
// captured the ticket counters accurately reflect the final state:
// reserved decrements and sold increments for each buyer in sequence.
//
// Flow:
//  1. Seed ticket (quota=5, maxPerUser=3).
//  2. buyer-1 reserves 3 units → reserved=3, sold=0.
//  3. buyer-2 reserves 2 units → reserved=5, sold=0.
//  4. buyer-1 payment captured (FinalizeReservation) → reserved=2, sold=3.
//  5. buyer-2 payment captured (FinalizeReservation) → reserved=0, sold=5.
//  6. Assert: quota == reserved + sold (invariant satisfied).
func TestGA_E2E_PaymentComplete_SoldCountersCorrect(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "e2e-ticket-ac2", "seller-1", "Payment Counters Show", 5, 3)

	// Step 1 – buyer-1 reserves 3 units.
	res1 := &repository.TicketReservation{
		ID:       "e2e-res-ac2-buyer1",
		TicketID: "e2e-ticket-ac2",
		UserID:   "e2e-buyer-1",
		Quantity: 3,
	}
	require.NoError(t, repo.CreateReservation(ctx, res1))

	// Step 2 – buyer-2 reserves 2 units.
	res2 := &repository.TicketReservation{
		ID:       "e2e-res-ac2-buyer2",
		TicketID: "e2e-ticket-ac2",
		UserID:   "e2e-buyer-2",
		Quantity: 2,
	}
	require.NoError(t, repo.CreateReservation(ctx, res2))

	ticket, err := repo.FindByID(ctx, "e2e-ticket-ac2")
	require.NoError(t, err)
	assert.Equal(t, 5, ticket.Reserved, "reserved should be 5 after both buyers reserve")
	assert.Equal(t, 0, ticket.Sold)

	// Step 3 – buyer-1 payment captured.
	require.NoError(t, repo.FinalizeReservation(ctx, "e2e-res-ac2-buyer1", "order-ac2-buyer1"))

	ticket, err = repo.FindByID(ctx, "e2e-ticket-ac2")
	require.NoError(t, err)
	assert.Equal(t, 2, ticket.Reserved, "reserved should be 2 after buyer-1 finalizes")
	assert.Equal(t, 3, ticket.Sold, "sold should be 3 after buyer-1 finalizes")

	// Step 4 – buyer-2 payment captured.
	require.NoError(t, repo.FinalizeReservation(ctx, "e2e-res-ac2-buyer2", "order-ac2-buyer2"))

	ticket, err = repo.FindByID(ctx, "e2e-ticket-ac2")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved, "reserved should be 0 after all payments finalized")
	assert.Equal(t, 5, ticket.Sold, "sold should equal quota when all units sold")

	// Core invariant: quota == reserved + sold (no units lost or created).
	assert.Equal(t, ticket.Quota, ticket.Reserved+ticket.Sold,
		"quota invariant: quota must equal reserved + sold")
}

// ─── AC-3: duplicate event replay is harmless ─────────────────────────────────

// TestGA_E2E_DuplicateEventReplay_Harmless verifies that replaying the same
// lifecycle events (due to Kafka at-least-once delivery) does not corrupt the
// reservation or ticket counters.
//
// Scenarios covered:
//
//	A. Duplicate FinalizeReservation (orders.order.completed replayed) →
//	   idempotent success; sold counter not double-counted.
//
//	B. Duplicate ReleaseReservation (orders.order.cancelled replayed) →
//	   idempotent success; reserved counter stays at 0 (not negative).
//
//	C. ReleaseReservation on an already-SOLD reservation →
//	   returns ErrReservationConflict; sold counter unchanged.
func TestGA_E2E_DuplicateEventReplay_Harmless(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "e2e-ticket-ac3", "seller-1", "Idempotency Show", 10, 5)

	// ── Scenario A: duplicate finalize ────────────────────────────────────────
	resA := &repository.TicketReservation{
		ID:       "e2e-res-ac3-a",
		TicketID: "e2e-ticket-ac3",
		UserID:   "e2e-buyer-a",
		Quantity: 2,
	}
	require.NoError(t, repo.CreateReservation(ctx, resA))
	require.NoError(t, repo.FinalizeReservation(ctx, "e2e-res-ac3-a", "order-ac3-a"))

	// Duplicate finalize (at-least-once delivery replay).
	require.NoError(t, repo.FinalizeReservation(ctx, "e2e-res-ac3-a", "order-ac3-a"),
		"duplicate FinalizeReservation must be a no-op success")

	ticket, err := repo.FindByID(ctx, "e2e-ticket-ac3")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved, "reserved must not go negative on duplicate finalize")
	assert.Equal(t, 2, ticket.Sold, "sold must not double-count on duplicate finalize")

	// ── Scenario B: duplicate release ─────────────────────────────────────────
	resB := &repository.TicketReservation{
		ID:       "e2e-res-ac3-b",
		TicketID: "e2e-ticket-ac3",
		UserID:   "e2e-buyer-b",
		Quantity: 1,
	}
	require.NoError(t, repo.CreateReservation(ctx, resB))
	require.NoError(t, repo.ReleaseReservation(ctx, "e2e-res-ac3-b"))

	// Duplicate release (orders.order.cancelled replayed).
	require.NoError(t, repo.ReleaseReservation(ctx, "e2e-res-ac3-b"),
		"duplicate ReleaseReservation must be a no-op success")

	ticket, err = repo.FindByID(ctx, "e2e-ticket-ac3")
	require.NoError(t, err)
	// Still the same as after Scenario A — reserved did not go below 0.
	assert.Equal(t, 0, ticket.Reserved, "reserved must not go negative on duplicate release")
	assert.Equal(t, 2, ticket.Sold, "sold counter unchanged by release")

	// ── Scenario C: release after finalize ────────────────────────────────────
	// E.g. cancel event arrives late after the payment was already processed.
	resC := &repository.TicketReservation{
		ID:       "e2e-res-ac3-c",
		TicketID: "e2e-ticket-ac3",
		UserID:   "e2e-buyer-c",
		Quantity: 1,
	}
	require.NoError(t, repo.CreateReservation(ctx, resC))
	require.NoError(t, repo.FinalizeReservation(ctx, "e2e-res-ac3-c", "order-ac3-c"))

	err = repo.ReleaseReservation(ctx, "e2e-res-ac3-c")
	assert.ErrorIs(t, err, repository.ErrReservationConflict,
		"releasing a SOLD reservation must return ErrReservationConflict, not silently decrement sold")

	ticket, err = repo.FindByID(ctx, "e2e-ticket-ac3")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved, "reserved unchanged after conflict")
	assert.Equal(t, 3, ticket.Sold, "sold must be 3 (2 from A + 1 from C); conflict must not corrupt counters")

	// Global invariant: reserved + sold must never exceed quota (not all quota
	// is consumed in this test — the check is a <= guard, not equality).
	assert.LessOrEqual(t, ticket.Reserved+ticket.Sold, ticket.Quota,
		"reserved + sold must never exceed quota after all idempotency scenarios")
}
