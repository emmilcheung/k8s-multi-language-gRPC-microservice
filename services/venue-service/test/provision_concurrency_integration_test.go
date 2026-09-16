package test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/migrations"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

// TestProvisionFromVenue_Idempotency verifies that ProvisionFromVenue is
// idempotent and correctly clones venue template sections into a plan.
func TestProvisionFromVenue_Idempotency(t *testing.T) {
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
	defer pool.Close()

	venueRepo := pgrepo.NewVenueRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	venueSectionRepo := pgrepo.NewVenueSectionRepo(pool)

	const organizerID = "00000000-0000-0000-0000-000000000001"
	const ticketID = "00000000-0000-0000-0000-000000000002"

	// ── Create venue ─────────────────────────────────────────────────────────────
	v := &repository.Venue{
		OrganizerID: organizerID,
		Name:        "Test Arena",
		Capacity:    1000,
		Timezone:    "UTC",
	}
	require.NoError(t, venueRepo.Create(ctx, v))

	// ── Create venue template sections ───────────────────────────────────────────
	// Create 3 templates: Section A seated 10x20, Section B seated 10x20, Section C GA 1x10
	sectionA := &repository.VenueSection{
		VenueID:      v.ID,
		Name:         "Section A",
		Type:         repository.SectionTypeSeated,
		RowCount:     10,
		ColumnCount:  20,
		DisplayOrder: 1,
	}
	sectionB := &repository.VenueSection{
		VenueID:      v.ID,
		Name:         "Section B",
		Type:         repository.SectionTypeSeated,
		RowCount:     10,
		ColumnCount:  20,
		DisplayOrder: 2,
	}
	sectionC := &repository.VenueSection{
		VenueID:      v.ID,
		Name:         "Section C",
		Type:         repository.SectionTypeGA,
		RowCount:     1,
		ColumnCount:  10,
		DisplayOrder: 3,
	}
	require.NoError(t, venueSectionRepo.Create(ctx, sectionA))
	require.NoError(t, venueSectionRepo.Create(ctx, sectionB))
	require.NoError(t, venueSectionRepo.Create(ctx, sectionC))

	// ── Create seating plan ──────────────────────────────────────────────────────
	p := &repository.SeatingPlan{
		VenueID:          v.ID,
		TicketID:         ticketID,
		OrganizerID:      organizerID,
		Name:             "Main Floor",
		MaxSeatsPerOrder: 4,
	}
	require.NoError(t, planRepo.Create(ctx, p))

	// ── First provision should return 3 ───────────────────────────────────────────
	count, err := sectionRepo.ProvisionFromVenue(ctx, p.ID, v.ID)
	require.NoError(t, err)
	assert.Equal(t, 3, count, "first provision should return 3 sections")

	// ── Second provision should return 0 (idempotent) ────────────────────────────
	count, err = sectionRepo.ProvisionFromVenue(ctx, p.ID, v.ID)
	require.NoError(t, err)
	assert.Equal(t, 0, count, "second provision should return 0 (idempotent)")

	// ── Verify sections were created ─────────────────────────────────────────────
	sections, err := sectionRepo.ListSectionsByPlan(ctx, p.ID)
	require.NoError(t, err)
	assert.Len(t, sections, 3, "plan should have 3 sections")

	// ── Verify seats were created: 10*20 + 10*20 + 10 = 410 ─────────────────────
	var seatCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM seats WHERE plan_id = $1`, p.ID).Scan(&seatCount))
	assert.Equal(t, 410, seatCount, "plan should have 410 seats total")
}

// TestProvisionFromVenue_DoesNotExhaustPoolUnderConcurrency verifies that
// concurrent provisions do not deadlock the pool. The fix uses a single
// transaction per provision, keeping each to one pooled connection.
func TestProvisionFromVenue_DoesNotExhaustPoolUnderConcurrency(t *testing.T) {
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
	require.NoError(t, err, "failed to start PostgreSQL container")
	t.Cleanup(func() {
		if termErr := pgContainer.Terminate(ctx); termErr != nil {
			t.Logf("warn: failed to terminate postgres container: %v", termErr)
		}
	})

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	require.NoError(t, migrations.Run(connStr, zap.NewNop()))

	// Use plain pgxpool.New(ctx, connStr) to get the DEFAULT pool size.
	// The default is max(4, numCPU). On this system with 4 CPUs, that's 4.
	// If the old buggy implementation held one connection per advisory lock
	// while inserting through the pool, all 4 connections would be consumed
	// by the lock transactions, and the inserts would deadlock.
	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	venueRepo := pgrepo.NewVenueRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	venueSectionRepo := pgrepo.NewVenueSectionRepo(pool)

	const organizerID = "00000000-0000-0000-0000-000000000001"
	const ticketID = "00000000-0000-0000-0000-000000000002"

	// ── Create venue ─────────────────────────────────────────────────────────────
	v := &repository.Venue{
		OrganizerID: organizerID,
		Name:        "Test Arena",
		Capacity:    1000,
		Timezone:    "UTC",
	}
	require.NoError(t, venueRepo.Create(ctx, v))

	// ── Create venue template sections ───────────────────────────────────────────
	sectionA := &repository.VenueSection{
		VenueID:      v.ID,
		Name:         "Section A",
		Type:         repository.SectionTypeSeated,
		RowCount:     10,
		ColumnCount:  20,
		DisplayOrder: 1,
	}
	sectionB := &repository.VenueSection{
		VenueID:      v.ID,
		Name:         "Section B",
		Type:         repository.SectionTypeSeated,
		RowCount:     10,
		ColumnCount:  20,
		DisplayOrder: 2,
	}
	sectionC := &repository.VenueSection{
		VenueID:      v.ID,
		Name:         "Section C",
		Type:         repository.SectionTypeGA,
		RowCount:     1,
		ColumnCount:  10,
		DisplayOrder: 3,
	}
	require.NoError(t, venueSectionRepo.Create(ctx, sectionA))
	require.NoError(t, venueSectionRepo.Create(ctx, sectionB))
	require.NoError(t, venueSectionRepo.Create(ctx, sectionC))

	// ── Create seating plan ──────────────────────────────────────────────────────
	p := &repository.SeatingPlan{
		VenueID:          v.ID,
		TicketID:         ticketID,
		OrganizerID:      organizerID,
		Name:             "Main Floor",
		MaxSeatsPerOrder: 4,
	}
	require.NoError(t, planRepo.Create(ctx, p))

	// ── Launch 8 concurrent provisions ───────────────────────────────────────────
	// With a 30-second timeout so a pool deadlock surfaces as a timeout failure
	// instead of hanging forever.
	provisionCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	var errCount atomic.Int32
	var countSum atomic.Int32

	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			count, err := sectionRepo.ProvisionFromVenue(provisionCtx, p.ID, v.ID)
			if err != nil {
				t.Logf("ProvisionFromVenue failed: %v", err)
				errCount.Add(1)
				return
			}
			countSum.Add(int32(count))
		}()
	}

	wg.Wait()

	// ── Verify no errors ─────────────────────────────────────────────────────────
	assert.Equal(t, int32(0), errCount.Load(),
		"all 8 concurrent provisions should complete without error")

	// ── Verify counts sum to 3 (exactly one caller provisioned) ──────────────────
	assert.Equal(t, int32(3), countSum.Load(),
		"the sum of all counts should be 3 (first caller got 3, rest got 0)")

	// ── Verify final state ───────────────────────────────────────────────────────
	sections, err := sectionRepo.ListSectionsByPlan(provisionCtx, p.ID)
	require.NoError(t, err)
	assert.Len(t, sections, 3, "plan should have exactly 3 sections")

	var seatCount int
	require.NoError(t, pool.QueryRow(provisionCtx, `SELECT COUNT(*) FROM seats WHERE plan_id = $1`, p.ID).Scan(&seatCount))
	assert.Equal(t, 410, seatCount, "plan should have exactly 410 seats")
}
