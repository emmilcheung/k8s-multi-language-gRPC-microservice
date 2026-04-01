package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
)

// newRepoForReservationTests spins up a MongoDB container and returns a fresh
// MongoTicketRepository. The container and repository are cleaned up via t.Cleanup.
func newRepoForReservationTests(t *testing.T) *repository.MongoTicketRepository {
	t.Helper()
	ctx := context.Background()

	mongoContainer, err := tcmongo.Run(ctx, "mongo:7", tcmongo.WithReplicaSet("rs0"))
	require.NoError(t, err, "start MongoDB container")
	t.Cleanup(func() { _ = mongoContainer.Terminate(ctx) })

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()))
	require.NoError(t, err)
	t.Cleanup(func() { _ = repo.Close(ctx) })

	return repo
}

// seedQuotaTicket inserts a ticket with explicit quota/maxPerUser settings and
// returns the persisted ticket (including server-set timestamps and version).
func seedQuotaTicket(t *testing.T, repo *repository.MongoTicketRepository, id, userID, title string, quota, maxPerUser int) *repository.Ticket {
	t.Helper()
	ticket := &repository.Ticket{
		ID:         id,
		Title:      title,
		Price:      "10.00",
		UserID:     userID,
		Quota:      quota,
		MaxPerUser: maxPerUser,
	}
	require.NoError(t, repo.Create(context.Background(), ticket))
	// Re-fetch to get the populated version/timestamps.
	created, err := repo.FindByID(context.Background(), id)
	require.NoError(t, err)
	return created
}

// ─── CreateReservation ────────────────────────────────────────────────────────

func TestCreateReservation_ShouldSucceed_WhenQuotaIsAvailable(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-1", "seller-1", "Test Show", 10, 3)

	res := &repository.TicketReservation{
		ID:       "res-1",
		TicketID: "ticket-1",
		UserID:   "buyer-1",
		Quantity: 2,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))

	// Reservation must be findable and in RESERVED state.
	found, err := repo.FindReservationByID(ctx, "res-1")
	require.NoError(t, err)
	assert.Equal(t, repository.ReservationStatusReserved, found.Status)
	assert.Equal(t, 2, found.Quantity)

	// Ticket reserved counter must have been incremented.
	ticket, err := repo.FindByID(ctx, "ticket-1")
	require.NoError(t, err)
	assert.Equal(t, 2, ticket.Reserved)
}

func TestCreateReservation_ShouldReturnErrInsufficientQuota_WhenNotEnoughInventory(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-2", "seller-1", "Sold Out Show", 2, 5)

	res := &repository.TicketReservation{
		ID:       "res-2",
		TicketID: "ticket-2",
		UserID:   "buyer-1",
		Quantity: 3, // exceeds quota of 2
	}
	err := repo.CreateReservation(ctx, res)
	assert.ErrorIs(t, err, repository.ErrInsufficientQuota)
}

func TestCreateReservation_ShouldReturnErrPerUserLimitExceeded_WhenCapBreached(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	// Quota is large but per-user cap is 1.
	seedQuotaTicket(t, repo, "ticket-3", "seller-1", "Capped Show", 100, 1)

	// First reservation: allowed.
	res1 := &repository.TicketReservation{
		ID:       "res-3a",
		TicketID: "ticket-3",
		UserID:   "buyer-1",
		Quantity: 1,
	}
	require.NoError(t, repo.CreateReservation(ctx, res1))

	// Second reservation by same user: exceeds per-user cap.
	res2 := &repository.TicketReservation{
		ID:       "res-3b",
		TicketID: "ticket-3",
		UserID:   "buyer-1",
		Quantity: 1,
	}
	err := repo.CreateReservation(ctx, res2)
	assert.ErrorIs(t, err, repository.ErrPerUserLimitExceeded)
}

func TestCreateReservation_ShouldReturnErrTicketNotFound_WhenTicketMissing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	res := &repository.TicketReservation{
		ID:       "res-4",
		TicketID: "nonexistent-ticket",
		UserID:   "buyer-1",
		Quantity: 1,
	}
	err := repo.CreateReservation(ctx, res)
	assert.ErrorIs(t, err, repository.ErrTicketNotFound)
}

func TestCreateReservation_ShouldRespectExpiresAt_WhenSet(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-5", "seller-1", "Expiry Test Show", 10, 5)

	expiresAt := time.Now().UTC().Add(15 * time.Minute)
	res := &repository.TicketReservation{
		ID:        "res-5",
		TicketID:  "ticket-5",
		UserID:    "buyer-1",
		Quantity:  1,
		ExpiresAt: &expiresAt,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))

	found, err := repo.FindReservationByID(ctx, "res-5")
	require.NoError(t, err)
	require.NotNil(t, found.ExpiresAt)
	assert.WithinDuration(t, expiresAt, *found.ExpiresAt, time.Second)
}

// ─── FindReservationByID ──────────────────────────────────────────────────────

func TestFindReservationByID_ShouldReturnErrReservationNotFound_WhenMissing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	_, err := repo.FindReservationByID(ctx, "does-not-exist")
	assert.ErrorIs(t, err, repository.ErrReservationNotFound)
}

// ─── ReleaseReservation ───────────────────────────────────────────────────────

func TestReleaseReservation_ShouldSucceed_WhenStatusIsReserved(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-6", "seller-1", "Release Show", 10, 5)
	res := &repository.TicketReservation{
		ID:       "res-6",
		TicketID: "ticket-6",
		UserID:   "buyer-1",
		Quantity: 2,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))

	require.NoError(t, repo.ReleaseReservation(ctx, "res-6"))

	// Reservation must now be RELEASED.
	found, err := repo.FindReservationByID(ctx, "res-6")
	require.NoError(t, err)
	assert.Equal(t, repository.ReservationStatusReleased, found.Status)

	// Ticket reserved counter must have been decremented back to 0.
	ticket, err := repo.FindByID(ctx, "ticket-6")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved)
}

func TestReleaseReservation_ShouldBeIdempotent_WhenAlreadyReleased(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-7", "seller-1", "Idempotent Release Show", 10, 5)
	res := &repository.TicketReservation{
		ID:       "res-7",
		TicketID: "ticket-7",
		UserID:   "buyer-1",
		Quantity: 1,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))
	require.NoError(t, repo.ReleaseReservation(ctx, "res-7"))

	// Second release must succeed without error.
	assert.NoError(t, repo.ReleaseReservation(ctx, "res-7"))

	// Reserved counter must still be 0 (not go negative).
	ticket, err := repo.FindByID(ctx, "ticket-7")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved)
}

func TestReleaseReservation_ShouldReturnErrReservationConflict_WhenSold(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-8", "seller-1", "Sold Show", 10, 5)
	res := &repository.TicketReservation{
		ID:       "res-8",
		TicketID: "ticket-8",
		UserID:   "buyer-1",
		Quantity: 1,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))
	require.NoError(t, repo.FinalizeReservation(ctx, "res-8", "order-abc"))

	err := repo.ReleaseReservation(ctx, "res-8")
	assert.ErrorIs(t, err, repository.ErrReservationConflict)
}

func TestReleaseReservation_ShouldReturnErrReservationNotFound_WhenMissing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	err := repo.ReleaseReservation(ctx, "does-not-exist")
	assert.ErrorIs(t, err, repository.ErrReservationNotFound)
}

// ─── FinalizeReservation ──────────────────────────────────────────────────────

func TestFinalizeReservation_ShouldSucceed_WhenStatusIsReserved(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-9", "seller-1", "Finalize Show", 10, 5)
	res := &repository.TicketReservation{
		ID:       "res-9",
		TicketID: "ticket-9",
		UserID:   "buyer-1",
		Quantity: 3,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))

	require.NoError(t, repo.FinalizeReservation(ctx, "res-9", "order-xyz"))

	// Reservation must be SOLD with orderId set.
	found, err := repo.FindReservationByID(ctx, "res-9")
	require.NoError(t, err)
	assert.Equal(t, repository.ReservationStatusSold, found.Status)
	assert.Equal(t, "order-xyz", found.OrderID)

	// Ticket counters: reserved decremented, sold incremented.
	ticket, err := repo.FindByID(ctx, "ticket-9")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved)
	assert.Equal(t, 3, ticket.Sold)
}

func TestFinalizeReservation_ShouldBeIdempotent_WhenAlreadySold(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-10", "seller-1", "Idempotent Finalize Show", 10, 5)
	res := &repository.TicketReservation{
		ID:       "res-10",
		TicketID: "ticket-10",
		UserID:   "buyer-1",
		Quantity: 1,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))
	require.NoError(t, repo.FinalizeReservation(ctx, "res-10", "order-111"))

	// Second finalize must succeed without error (idempotent no-op).
	assert.NoError(t, repo.FinalizeReservation(ctx, "res-10", "order-111"))

	// Sold counter must remain 1 (not double-counted).
	ticket, err := repo.FindByID(ctx, "ticket-10")
	require.NoError(t, err)
	assert.Equal(t, 0, ticket.Reserved)
	assert.Equal(t, 1, ticket.Sold)
}

func TestFinalizeReservation_ShouldReturnErrReservationConflict_WhenReleased(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	seedQuotaTicket(t, repo, "ticket-11", "seller-1", "Released Show", 10, 5)
	res := &repository.TicketReservation{
		ID:       "res-11",
		TicketID: "ticket-11",
		UserID:   "buyer-1",
		Quantity: 1,
	}
	require.NoError(t, repo.CreateReservation(ctx, res))
	require.NoError(t, repo.ReleaseReservation(ctx, "res-11"))

	err := repo.FinalizeReservation(ctx, "res-11", "order-zzz")
	assert.ErrorIs(t, err, repository.ErrReservationConflict)
}

func TestFinalizeReservation_ShouldReturnErrReservationNotFound_WhenMissing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	err := repo.FinalizeReservation(ctx, "does-not-exist", "order-000")
	assert.ErrorIs(t, err, repository.ErrReservationNotFound)
}

// ─── Counter invariants ───────────────────────────────────────────────────────

func TestReservationCounters_ShouldNeverExceedQuota_UnderSequentialLoad(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	// Ticket with quota 3, maxPerUser 3 (one buyer will hold all).
	seedQuotaTicket(t, repo, "ticket-12", "seller-1", "Quota Guard Show", 3, 3)

	makeRes := func(id string, qty int) *repository.TicketReservation {
		return &repository.TicketReservation{
			ID:       id,
			TicketID: "ticket-12",
			UserID:   "buyer-bulk",
			Quantity: qty,
		}
	}

	// Reserve 2 units.
	require.NoError(t, repo.CreateReservation(ctx, makeRes("res-12a", 2)))

	// Try to reserve 2 more (quota = 3, reserved = 2 → available = 1 < 2).
	err := repo.CreateReservation(ctx, makeRes("res-12b", 2))
	assert.ErrorIs(t, err, repository.ErrInsufficientQuota)

	// Reserve 1 more (fills quota exactly).
	require.NoError(t, repo.CreateReservation(ctx, makeRes("res-12c", 1)))

	ticket, err := repo.FindByID(ctx, "ticket-12")
	require.NoError(t, err)
	assert.Equal(t, 3, ticket.Reserved)
	assert.Equal(t, 0, ticket.Sold)
	assert.Equal(t, ticket.Quota, ticket.Reserved+ticket.Sold)
}
