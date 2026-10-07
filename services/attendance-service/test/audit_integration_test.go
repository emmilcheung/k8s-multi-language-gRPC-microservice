package test

import (
	"context"
	"testing"

	"github.com/acme/attendance-service/internal/audit"
	"github.com/acme/attendance-service/internal/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

func newAuditPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	if !isDockerAvailable() {
		t.Skip("skipping integration test: Docker not available")
	}
	ctx := context.Background()
	pg, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("attendance_test"),
		tcpostgres.WithUsername("attendance_user"),
		tcpostgres.WithPassword("attendance_pass"),
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = pg.Terminate(ctx) })
	connStr, err := pg.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	require.NoError(t, migrations.Run(connStr, zap.NewNop()))
	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

func auditEntry() audit.Entry {
	return audit.Entry{
		ActorUserID:    "user-1",
		ActorAccountID: "acct-1",
		Action:         "policy.update",
		Resource:       "event:e1",
		Before:         map[string]any{"allowManualOverride": false},
		After:          map[string]any{"allowManualOverride": true},
		Reason:         "typo",
		TraceID:        "trace-1",
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n))
	return n
}

func insertPolicy(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `INSERT INTO event_attendance_policies (event_id, organizer_id) VALUES ($1, $1)`, "00000000-0000-0000-0000-000000000001")
	return err
}

func TestAudit_ShouldCommitRowWithTheCommand_WhenTransactionCommits(t *testing.T) {
	pool := newAuditPool(t)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, insertPolicy(ctx, tx))
	require.NoError(t, audit.Record(ctx, tx, auditEntry()))
	require.NoError(t, tx.Commit(ctx))

	assert.Equal(t, 1, countRows(t, pool, "event_attendance_policies"))
	var actor, resource, before, after, reason, traceID string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT actor_user_id, resource, before::text, after::text, reason, trace_id FROM audit_log`).
		Scan(&actor, &resource, &before, &after, &reason, &traceID))
	assert.Equal(t, "user-1", actor)
	assert.Equal(t, "event:e1", resource)
	assert.JSONEq(t, `{"allowManualOverride":false}`, before)
	assert.JSONEq(t, `{"allowManualOverride":true}`, after)
	assert.Equal(t, "typo", reason)
	assert.Equal(t, "trace-1", traceID)
}

func TestAudit_ShouldLeaveNeitherChangeNorRow_WhenCommandFailsAfterAuditing(t *testing.T) {
	pool := newAuditPool(t)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, insertPolicy(ctx, tx))
	require.NoError(t, audit.Record(ctx, tx, auditEntry()))
	require.NoError(t, tx.Rollback(ctx))

	assert.Equal(t, 0, countRows(t, pool, "event_attendance_policies"))
	assert.Equal(t, 0, countRows(t, pool, "audit_log"))
}

func TestAudit_ShouldRollBackTheCommand_WhenTheAuditRowCannotBeWritten(t *testing.T) {
	pool := newAuditPool(t)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, insertPolicy(ctx, tx))
	bad := auditEntry()
	bad.ActorUserID = "" // actor is required
	require.Error(t, audit.Record(ctx, tx, bad))
	require.NoError(t, tx.Rollback(ctx))

	assert.Equal(t, 0, countRows(t, pool, "event_attendance_policies"))
}

func TestAudit_ShouldNeverStoreAttendeeNamesOrEmails(t *testing.T) {
	pool := newAuditPool(t)
	ctx := context.Background()

	e := auditEntry()
	e.Before = map[string]any{"attendeeName": "Ada", "seats": 1}
	e.After = map[string]any{"attendeeEmail": "ada@example.com", "seats": 2}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, audit.Record(ctx, tx, e))
	require.NoError(t, tx.Commit(ctx))

	var all string
	require.NoError(t, pool.QueryRow(ctx, `SELECT before::text || after::text FROM audit_log`).Scan(&all))
	assert.NotContains(t, all, "Ada")
	assert.NotContains(t, all, "ada@example.com")
	assert.Contains(t, all, "[redacted]")
}
