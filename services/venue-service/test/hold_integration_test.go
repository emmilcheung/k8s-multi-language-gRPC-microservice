package test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/migrations"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

// TestHold_ShouldSupportHoldAndReleaseCycle validates the full hold/release/
// sweep lifecycle against a real PostgreSQL container (no Redis — DB-only path).
func TestHold_ShouldSupportHoldAndReleaseCycle(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	mgr := hold.NewManager(nil /* Redis disabled */, sectionRepo, planRepo, zap.NewNop())

	const userID = "00000000-0000-0000-0000-000000000010"
	const sessionID = "session-abc"

	// ── Hold two seats ────────────────────────────────────────────────────────
	result, err := mgr.HoldSeats(ctx, planID, userID, sessionID, seatIDs[:2])
	require.NoError(t, err)
	assert.Len(t, result.Held, 2)
	assert.True(t, result.ExpiresAt.After(time.Now()))

	// ── Second user cannot hold the same seats ────────────────────────────────
	const user2ID = "00000000-0000-0000-0000-000000000020"
	_, err = mgr.HoldSeats(ctx, planID, user2ID, sessionID, seatIDs[:1])
	assert.ErrorIs(t, err, repository.ErrSeatNotAvailable,
		"second user should not be able to hold already-held seat")

	// ── Availability snapshot reflects HELD status ────────────────────────────
	snap, err := mgr.GetAvailability(ctx, planID)
	require.NoError(t, err)
	assert.Equal(t, "held", snap.SeatMap[seatIDs[0]].Status)
	assert.Equal(t, "held", snap.SeatMap[seatIDs[1]].Status)
	assert.Equal(t, "available", snap.SeatMap[seatIDs[2]].Status)

	// ── Release hold ──────────────────────────────────────────────────────────
	require.NoError(t, mgr.ReleaseHold(ctx, planID, userID, seatIDs[:2]))

	snap2, err := mgr.GetAvailability(ctx, planID)
	require.NoError(t, err)
	assert.Equal(t, "available", snap2.SeatMap[seatIDs[0]].Status, "seat should be available after release")
	assert.Equal(t, "available", snap2.SeatMap[seatIDs[1]].Status, "seat should be available after release")

	// ── User 2 can now hold the released seats ────────────────────────────────
	result2, err := mgr.HoldSeats(ctx, planID, user2ID, sessionID, seatIDs[:1])
	require.NoError(t, err)
	assert.Len(t, result2.Held, 1)
}

// TestHold_ShouldRejectHoldOnInactivePlan verifies that holds fail when the
// seating plan is not in the active state.
func TestHold_ShouldRejectHoldOnInactivePlan(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("venue_test"),
		tcpostgres.WithUsername("venue_user"),
		tcpostgres.WithPassword("venue_pass"),
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err)
	t.Cleanup(func() {
		if termErr := pgContainer.Terminate(ctx); termErr != nil {
			t.Logf("warn: failed to terminate postgres container: %v", termErr)
		}
	})

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	require.NoError(t, migrations.Run(connStr, zap.NewNop()))

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	venueRepo := pgrepo.NewVenueRepo(pool)
	mgr := hold.NewManager(nil, sectionRepo, planRepo, zap.NewNop())

	// Create venue + draft plan (NOT activated).
	v := &repository.Venue{
		OrganizerID: "00000000-0000-0000-0000-000000000001",
		Name:        "Test Arena",
		Capacity:    100,
		Timezone:    "UTC",
	}
	require.NoError(t, venueRepo.Create(ctx, v))

	p := &repository.SeatingPlan{
		VenueID:          v.ID,
		OrganizerID:      "00000000-0000-0000-0000-000000000001",
		Name:             "Draft Plan",
		HoldTTLSec:       60,
		MaxSeatsPerOrder: 4,
	}
	require.NoError(t, planRepo.Create(ctx, p))

	_, err = mgr.HoldSeats(ctx, p.ID, "00000000-0000-0000-0000-000000000010", "session-1", []string{"any-seat"})
	assert.ErrorIs(t, err, hold.ErrPlanNotActive)
}

// TestHold_ShouldSweepExpiredHolds verifies that SweepExpiredHolds releases
// seats whose held_until timestamp has passed.
func TestHold_ShouldSweepExpiredHolds(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	mgr := hold.NewManager(nil, sectionRepo, planRepo, zap.NewNop())

	const userID = "00000000-0000-0000-0000-000000000010"

	// Hold with a 1 ms TTL (already expired by the time we call sweep).
	expiresAt := time.Now().UTC().Add(-1 * time.Millisecond)
	err := sectionRepo.HoldSeats(ctx, seatIDs[:1], userID, expiresAt)
	require.NoError(t, err)

	// Sweep should release it.
	n, err := mgr.SweepExpiredHolds(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, n, int64(1))

	snap, err := mgr.GetAvailability(ctx, planID)
	require.NoError(t, err)
	assert.Equal(t, "available", snap.SeatMap[seatIDs[0]].Status,
		"seat should be available after sweep")
}

// TestHold_ConcurrentHoldContention verifies that only one of N concurrent
// hold requests for the same seat succeeds.
func TestHold_ConcurrentHoldContention(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	mgr := hold.NewManager(nil, sectionRepo, planRepo, zap.NewNop())

	// 10 concurrent users each try to hold the same single seat.
	const concurrency = 10
	var successCount atomic.Int32
	var wg sync.WaitGroup
	wg.Add(concurrency)

	targetSeat := seatIDs[:1]

	for i := 0; i < concurrency; i++ {
		go func(idx int) {
			defer wg.Done()
			userID := "00000000-0000-0000-0000-" + zeroPad(idx+1)
			_, holdErr := mgr.HoldSeats(ctx, planID, userID, "session", targetSeat)
			if holdErr == nil {
				successCount.Add(1)
			}
		}(i)
	}

	wg.Wait()

	assert.Equal(t, int32(1), successCount.Load(),
		"exactly one concurrent hold request should succeed")
}

// zeroPad returns a 12-digit zero-padded decimal string for constructing UUIDs.
func zeroPad(n int) string {
	return leftPad(itoa(n), 12, '0')
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := make([]byte, 0, 10)
	for n > 0 {
		digits = append(digits, byte('0'+n%10))
		n /= 10
	}
	// reverse
	for i, j := 0, len(digits)-1; i < j; i, j = i+1, j-1 {
		digits[i], digits[j] = digits[j], digits[i]
	}
	return string(digits)
}

func leftPad(s string, length int, pad byte) string {
	for len(s) < length {
		s = string(pad) + s
	}
	return s
}

// ── fixture helper ────────────────────────────────────────────────────────────

// setupHoldFixture creates a Testcontainers PostgreSQL instance with:
// - a venue, an ACTIVE seating plan, one section, and 3 seats.
// Returns the pool, planID, and the 3 seat IDs.
func setupHoldFixture(t *testing.T, ctx context.Context) (*pgxpool.Pool, string, []string) {
	t.Helper()

	pgContainer, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("venue_test"),
		tcpostgres.WithUsername("venue_user"),
		tcpostgres.WithPassword("venue_pass"),
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err, "failed to start PostgreSQL container")
	t.Cleanup(func() {
		if termErr := pgContainer.Terminate(ctx); termErr != nil {
			t.Logf("warn: failed to terminate postgres container: %v", termErr)
		}
	})

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	require.NoError(t, migrations.Run(connStr, zap.NewNop()))

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)

	venueRepo := pgrepo.NewVenueRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	priceTierRepo := pgrepo.NewPriceTierRepo(pool)

	const organizerID = "00000000-0000-0000-0000-000000000001"
	const ticketID = "00000000-0000-0000-0000-000000000002"

	v := &repository.Venue{
		OrganizerID: organizerID,
		Name:        "Hold Test Arena",
		Capacity:    100,
		Timezone:    "UTC",
	}
	require.NoError(t, venueRepo.Create(ctx, v))

	p := &repository.SeatingPlan{
		VenueID:          v.ID,
		OrganizerID:      organizerID,
		Name:             "Hold Test Plan",
		HoldTTLSec:       600,
		MaxSeatsPerOrder: 4,
	}
	require.NoError(t, planRepo.Create(ctx, p))

	sec := &repository.Section{
		PlanID:      p.ID,
		Name:        "Floor A",
		Type:        repository.SectionTypeSeated,
		RowCount:    1,
		ColumnCount: 3,
	}
	require.NoError(t, sectionRepo.CreateSection(ctx, sec))

	tier := &repository.PriceTier{PlanID: p.ID, Name: "Standard", Price: "50.00"}
	require.NoError(t, priceTierRepo.Create(ctx, tier))

	// Create 3 seats.
	seatIDs := make([]string, 3)
	for i := 0; i < 3; i++ {
		seat := &repository.Seat{
			SectionID:    sec.ID,
			PlanID:       p.ID,
			PriceTierID:  tier.ID,
			SeatLabel:    "A" + itoa(i+1),
			RowLabel:     "A",
			ColumnNumber: i + 1,
		}
		require.NoError(t, sectionRepo.UpsertSeat(ctx, seat))
		seatIDs[i] = seat.ID
	}

	// Attach ticket and activate plan so holds are allowed.
	require.NoError(t, planRepo.AttachTicket(ctx, p.ID, ticketID, p.Version))
	freshPlan, err := planRepo.FindByID(ctx, p.ID)
	require.NoError(t, err)
	require.NoError(t, planRepo.Activate(ctx, p.ID, freshPlan.Version))

	return pool, p.ID, seatIDs
}
