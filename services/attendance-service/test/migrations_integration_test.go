// Package test contains integration tests for attendance-service.
// Tests that require external services (PostgreSQL) use Testcontainers
// and are skipped when -short is passed or Docker is unavailable.
package test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/acme/attendance-service/internal/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tc "github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

// TestMigrationSQL_IndexNames verifies that the migration SQL uses correct,
// non-misleading index names that align with the columns they index.
func TestMigrationSQL_IndexNames(t *testing.T) {
	sql, err := os.ReadFile("../internal/migrations/001_schema.up.sql")
	require.NoError(t, err, "should be able to read migration file")

	content := string(sql)

	// The old misleading name must not appear.
	assert.NotContains(t, content, "idx_admission_credentials_credential_id",
		"index name 'idx_admission_credentials_credential_id' is misleading: it indexes (id), not a credential_id FK column")

	// The correct name must be present.
	assert.Contains(t, content, "idx_admission_credentials_id",
		"expected index 'idx_admission_credentials_id' on admission_credentials (id)")

	// Sanity: other expected indexes are intact.
	for _, name := range []string{
		"idx_admission_credentials_ticket_id",
		"idx_admission_credentials_event_id",
		"idx_admission_credentials_status",
		"idx_admission_credentials_order_id",
	} {
		assert.True(t, strings.Contains(content, name), "expected index %q to still be present", name)
	}
}

// isDockerAvailable returns true when a Docker daemon is reachable.
func isDockerAvailable() bool {
	_, err := tc.NewDockerClientWithOpts(context.Background())
	return err == nil
}

// TestMigrations_ShouldApplyAllSchemas_WhenDBIsEmpty spins up a real PostgreSQL
// container, runs all attendance-service migrations, and verifies that all expected
// tables exist.
func TestMigrations_ShouldApplyAllSchemas_WhenDBIsEmpty(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	if !isDockerAvailable() {
		t.Skip("skipping integration test: Docker not available")
	}

	ctx := context.Background()

	pgContainer, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("attendance_test"),
		tcpostgres.WithUsername("attendance_user"),
		tcpostgres.WithPassword("attendance_pass"),
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

	// Verify idempotency.
	require.NoError(t, migrations.Run(connStr, log), "migrations.Run is not idempotent")

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	expectedTables := []string{
		"event_attendance_policies",
		"admission_credentials",
		"scan_events",
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

// TestReadiness_ShouldPassWithPostgres verifies that after migration the DB
// is reachable via the health checker interface.
func TestReadiness_ShouldPassWithPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	if !isDockerAvailable() {
		t.Skip("skipping integration test: Docker not available")
	}

	ctx := context.Background()

	pgContainer, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("attendance_test"),
		tcpostgres.WithUsername("attendance_user"),
		tcpostgres.WithPassword("attendance_pass"),
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = pgContainer.Terminate(ctx) })

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	log := zap.NewNop()
	require.NoError(t, migrations.Run(connStr, log))

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	require.NoError(t, pool.Ping(ctx), "postgres readiness ping should pass")
}
