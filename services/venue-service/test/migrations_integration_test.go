// Package test contains integration tests for venue-service.
// Tests that require external services (PostgreSQL, Kafka) use Testcontainers
// and are skipped when -short is passed or Docker is unavailable.
package test

import (
	"context"
	"fmt"
	"testing"

	"github.com/acme/venue-service/internal/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

// TestMigrations_ShouldApplyAllSchemas_WhenDBIsEmpty spins up a real PostgreSQL
// container, runs all venue-service migrations, and verifies that all expected
// tables exist.
func TestMigrations_ShouldApplyAllSchemas_WhenDBIsEmpty(t *testing.T) {
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
	require.NoError(t, err, "failed to get connection string")

	log := zap.NewNop()
	require.NoError(t, migrations.Run(connStr, log), "migrations.Run should succeed")

	// Verify idempotency — running a second time must not error.
	require.NoError(t, migrations.Run(connStr, log), "migrations.Run is not idempotent")

	// Verify all expected tables exist.
	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	expectedTables := []string{
		"venues",
		"seating_plans",
		"sections",
		"price_tiers",
		"seats",
		"seat_reservations",
		"seat_reservation_items",
	}

	for _, table := range expectedTables {
		t.Run(fmt.Sprintf("table_%s_exists", table), func(t *testing.T) {
			var count int
			err := pool.QueryRow(ctx,
				"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
				table,
			).Scan(&count)
			require.NoError(t, err)
			assert.Equal(t, 1, count, "expected table %q to exist", table)
		})
	}
}
