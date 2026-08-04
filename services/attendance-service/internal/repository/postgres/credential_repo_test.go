package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIsUniqueViolation(t *testing.T) {
	assert.True(t, isUniqueViolation(&pgconn.PgError{Code: "23505"}))
	assert.False(t, isUniqueViolation(&pgconn.PgError{Code: "23503"}))
	assert.False(t, isUniqueViolation(errors.New("boom")))
}

// requireTestPool opens a real Postgres pool from the TEST_DATABASE_URL
// environment variable and skips the test if the variable is unset or the
// pool cannot connect.  Tests that call this function are integration tests
// and require a running Postgres instance.
func requireTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("cannot open test pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("cannot ping test postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestListUnpublished_TwoCallersSeeDisjointRows verifies that two concurrent
// relay replicas claim disjoint sets of outbox rows when ListUnpublishedTx is
// used with FOR UPDATE SKIP LOCKED.
//
// The test requires a live Postgres instance reachable via TEST_DATABASE_URL.
// If the variable is unset the test is skipped automatically.
func TestListUnpublished_TwoCallersSeeDisjointRows(t *testing.T) {
	pool := requireTestPool(t)
	ctx := context.Background()
	repo := NewCredentialRepo(pool)

	ensureOutboxTable(t, pool)

	// Rows are tagged by topic, not by id: outbox.id is UUID in the migrated
	// schema (004_outbox.up.sql), so filtering on `id LIKE ...` fails with
	// "operator does not exist: uuid ~~ unknown" against a real database.
	const marker = "skip-locked-test.topic"
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM outbox WHERE topic = $1`, marker)
	}
	cleanup()
	t.Cleanup(cleanup)

	// Seed three unpublished rows.
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		seedOutboxRow(t, pool, marker, false, now)
	}

	// Open two transactions and claim rows from each concurrently.
	tx1, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx1.Rollback(ctx) //nolint:errcheck

	tx2, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx2.Rollback(ctx) //nolint:errcheck

	// tx1 claims first — it should see all three rows (none yet locked).
	rows1, err := repo.ListUnpublishedTx(ctx, tx1, 10)
	require.NoError(t, err)

	// tx2 claims next — SKIP LOCKED means it skips the rows held by tx1.
	rows2, err := repo.ListUnpublishedTx(ctx, tx2, 10)
	require.NoError(t, err)

	// Build ID sets for overlap check.
	set1 := make(map[string]bool, len(rows1))
	for _, r := range rows1 {
		set1[r.ID] = true
	}
	for _, r := range rows2 {
		assert.False(t, set1[r.ID],
			"outbox row %s was returned by both transactions; SKIP LOCKED not working", r.ID)
	}

	// Together the two transactions must cover the three seeded rows with no
	// gaps (tx2 may be empty if tx1 claimed all three, which is also correct).
	// Count only this test's rows — other rows may exist in a shared database.
	totalClaimed := 0
	for _, r := range append(append([]*repository.OutboxRow{}, rows1...), rows2...) {
		if r.Topic == marker {
			totalClaimed++
		}
	}
	assert.Equal(t, 3, totalClaimed,
		"expected both transactions to together claim all 3 seeded rows, got %d", totalClaimed)
}

// ensureOutboxTable creates the outbox table if the target database has no
// migrations applied.  The column types mirror 004_outbox.up.sql + 008 exactly
// (notably id UUID, not TEXT) so these tests behave identically against a
// migrated database and an empty one.
func ensureOutboxTable(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		CREATE TABLE IF NOT EXISTS outbox (
			id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
			topic         TEXT        NOT NULL,
			payload       JSONB       NOT NULL,
			trace_headers JSONB       NOT NULL DEFAULT '{}',
			partition_key TEXT        NOT NULL,
			published     BOOLEAN     NOT NULL DEFAULT false,
			published_at  TIMESTAMPTZ,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
		)`)
	require.NoError(t, err)
}

// seedOutboxRow inserts one row tagged with `topic` so a test can find and clean
// up its own rows without depending on the id column's type.
func seedOutboxRow(t *testing.T, pool *pgxpool.Pool, topic string, published bool, createdAt time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO outbox (topic, payload, trace_headers, partition_key, published, created_at)
		 VALUES ($1, '{}'::jsonb, '{}'::jsonb, 'pk', $2, $3)`,
		topic, published, createdAt)
	require.NoError(t, err)
}

// TestDeletePublishedBefore_PurgesOnlyPublishedRowsPastCutoff exercises the real
// DELETE ... WHERE id IN (SELECT ... LIMIT) statement against Postgres.  The
// unit-level cleanup test uses an in-memory double, so this is the only place the
// actual SQL — including the bounded sub-select — is proven to filter on both
// `published` and `created_at`.  Deleting an unpublished row here would mean
// losing an event permanently.
func TestDeletePublishedBefore_PurgesOnlyPublishedRowsPastCutoff(t *testing.T) {
	pool := requireTestPool(t)
	ctx := context.Background()
	repo := NewCredentialRepo(pool)
	ensureOutboxTable(t, pool)

	const (
		oldPublished   = "purge-test.old-published"
		oldUnpublished = "purge-test.old-unpublished"
		newPublished   = "purge-test.new-published"
	)
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM outbox WHERE topic LIKE 'purge-test.%'`)
	}
	cleanup()
	t.Cleanup(cleanup)

	now := time.Now().UTC()
	seedOutboxRow(t, pool, oldPublished, true, now.Add(-48*time.Hour))
	seedOutboxRow(t, pool, oldUnpublished, false, now.Add(-48*time.Hour))
	seedOutboxRow(t, pool, newPublished, true, now.Add(-time.Hour))

	deleted, err := repo.DeletePublishedBefore(ctx, now.Add(-24*time.Hour), 500)
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)

	var remaining []string
	rows, err := pool.Query(ctx,
		`SELECT topic FROM outbox WHERE topic LIKE 'purge-test.%' ORDER BY topic`)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var topic string
		require.NoError(t, rows.Scan(&topic))
		remaining = append(remaining, topic)
	}
	require.NoError(t, rows.Err())

	assert.Equal(t, []string{newPublished, oldUnpublished}, remaining,
		"only published rows past the cutoff may be purged; an unpublished row deleted here is an event lost forever")
}

// TestDeletePublishedBefore_RespectsLimit proves the LIMIT in the sub-select is
// applied, which is what keeps one purge statement's lock hold time bounded.
func TestDeletePublishedBefore_RespectsLimit(t *testing.T) {
	pool := requireTestPool(t)
	ctx := context.Background()
	repo := NewCredentialRepo(pool)
	ensureOutboxTable(t, pool)

	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM outbox WHERE topic = 'purge-limit.test'`)
	}
	cleanup()
	t.Cleanup(cleanup)

	old := time.Now().UTC().Add(-48 * time.Hour)
	for i := 0; i < 5; i++ {
		seedOutboxRow(t, pool, "purge-limit.test", true, old)
	}

	deleted, err := repo.DeletePublishedBefore(ctx, time.Now().UTC().Add(-24*time.Hour), 2)
	require.NoError(t, err)
	assert.Equal(t, int64(2), deleted, "the statement must delete at most `limit` rows per call")
}
