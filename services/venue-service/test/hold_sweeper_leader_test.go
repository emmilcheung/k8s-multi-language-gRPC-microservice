package test

import (
	"context"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/migrations"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

// TestHoldSweeper_LeaderElection verifies that only one pod sweeps expired holds per tick
// via advisory locking, and that non-leader pods skip the sweep and return (0, nil).
func TestHoldSweeper_LeaderElection(t *testing.T) {
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

	// Pin MaxConns to allow a second connection for the leader simulation.
	poolCfg, err := pgxpool.ParseConfig(connStr)
	require.NoError(t, err)
	poolCfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
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

	// ── Create venue template section ────────────────────────────────────────────
	section := &repository.VenueSection{
		VenueID:      v.ID,
		Name:         "Section A",
		Type:         repository.SectionTypeSeated,
		RowCount:     1,
		ColumnCount:  5,
		DisplayOrder: 1,
	}
	require.NoError(t, venueSectionRepo.Create(ctx, section))

	// ── Create seating plan ──────────────────────────────────────────────────────
	p := &repository.SeatingPlan{
		VenueID:          v.ID,
		TicketID:         ticketID,
		OrganizerID:      organizerID,
		Name:             "Main Floor",
		MaxSeatsPerOrder: 4,
	}
	require.NoError(t, planRepo.Create(ctx, p))

	// ── Provision seating (creates 5 seats) ───────────────────────────────────────
	_, err = sectionRepo.ProvisionFromVenue(ctx, p.ID, v.ID)
	require.NoError(t, err)

	// ── Create expired holds on 3 seats ──────────────────────────────────────────
	expiredTime := time.Now().Add(-time.Hour)
	holderID := "00000000-0000-0000-0000-000000000099"
	_, err = pool.Exec(ctx, `
		UPDATE seats
		SET status='HELD', held_by=$1, held_until = $2
		WHERE plan_id = $3 AND id IN (SELECT id FROM seats WHERE plan_id = $3 LIMIT 3)
	`, holderID, expiredTime, p.ID)
	require.NoError(t, err)

	// Verify 3 seats are held before sweep
	var heldCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM seats WHERE plan_id = $1 AND status='HELD'
	`, p.ID).Scan(&heldCount)
	require.NoError(t, err)
	require.Equal(t, 3, heldCount, "exactly 3 seats should be held before sweep")

	// ── Step 1: Simulate another pod being the leader ───────────────────────────
	leaderConn, err := pool.Acquire(ctx)
	require.NoError(t, err, "failed to acquire separate connection for leader simulation")

	_, err = leaderConn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, "venue-hold-sweeper")
	require.NoError(t, err, "failed to acquire leader lock from separate connection")

	// ── Step 2: Call SweepExpiredHolds; should return 0 because we don't have the lock
	swept, err := sectionRepo.SweepExpiredHolds(ctx)
	require.NoError(t, err, "SweepExpiredHolds should not error when another pod holds the lock")
	require.Equal(t, int64(0), swept, "a non-leader pod must not sweep while another pod holds the leader lock")

	// ── Step 3: Verify seats are still HELD ──────────────────────────────────────
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM seats WHERE plan_id = $1 AND status='HELD'
	`, p.ID).Scan(&heldCount)
	require.NoError(t, err)
	require.Equal(t, 3, heldCount, "seats must be untouched because this pod is not the leader; if they were swept, the sweeper ran without leader election")

	// ── Step 4: Release the outside lock ─────────────────────────────────────────
	_, err = leaderConn.Exec(ctx, `SELECT pg_advisory_unlock(hashtext($1))`, "venue-hold-sweeper")
	require.NoError(t, err)
	leaderConn.Release()

	// ── Step 5: Call SweepExpiredHolds again; now we should be leader and sweep ──
	swept, err = sectionRepo.SweepExpiredHolds(ctx)
	require.NoError(t, err, "SweepExpiredHolds should succeed when no other pod holds the lock")
	require.Equal(t, int64(3), swept, "with the leader lock free this pod must sweep and release 3 held seats")

	// ── Step 6: Verify seats are now AVAILABLE ───────────────────────────────────
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM seats WHERE plan_id = $1 AND status='HELD'
	`, p.ID).Scan(&heldCount)
	require.NoError(t, err)
	require.Equal(t, 0, heldCount, "all held seats must be released after sweep; count should be 0")
}
