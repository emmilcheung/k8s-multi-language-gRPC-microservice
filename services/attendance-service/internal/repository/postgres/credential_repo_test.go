package postgres

import (
	"context"
	"encoding/json"
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

	// Ensure the outbox table exists with the minimum columns we need.
	// In CI the schema is applied by migrations; in ad-hoc runs against an
	// empty DB this guarantees the table is present.
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS outbox (
			id            TEXT PRIMARY KEY,
			topic         TEXT NOT NULL,
			payload       JSONB NOT NULL DEFAULT '{}',
			trace_headers JSONB NOT NULL DEFAULT '{}',
			partition_key TEXT NOT NULL DEFAULT '',
			published     BOOLEAN NOT NULL DEFAULT false,
			published_at  TIMESTAMPTZ,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
		)`)
	require.NoError(t, err)

	// Clean up any leftover rows from a previous run.
	_, err = pool.Exec(ctx, `DELETE FROM outbox WHERE id LIKE 'skip-locked-test-%'`)
	require.NoError(t, err)

	// Seed three unpublished rows.
	payload := json.RawMessage(`{}`)
	traceHeaders := json.RawMessage(`{}`)
	for i := 0; i < 3; i++ {
		row := &repository.OutboxRow{
			ID:           "skip-locked-test-" + string(rune('a'+i)),
			Topic:        "test.topic",
			Payload:      payload,
			TraceHeaders: traceHeaders,
			PartitionKey: "pk",
		}
		_, err := pool.Exec(ctx,
			`INSERT INTO outbox (id, topic, payload, trace_headers, partition_key, published)
			 VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, false)
			 ON CONFLICT (id) DO NOTHING`,
			row.ID, row.Topic, string(row.Payload), string(row.TraceHeaders), row.PartitionKey,
		)
		require.NoError(t, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM outbox WHERE id LIKE 'skip-locked-test-%'`)
	})

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
	totalClaimed := len(rows1) + len(rows2)
	assert.Equal(t, 3, totalClaimed,
		"expected both transactions to together claim all 3 seeded rows, got %d", totalClaimed)
}
