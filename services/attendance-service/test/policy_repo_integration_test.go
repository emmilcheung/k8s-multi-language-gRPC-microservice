package test

import (
	"context"
	"testing"

	"github.com/acme/attendance-service/internal/migrations"
	"github.com/acme/attendance-service/internal/repository"
	repopostgres "github.com/acme/attendance-service/internal/repository/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

func TestPolicyRepo_Upsert_ShouldUpdateExistingEventPolicy(t *testing.T) {
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
	require.NoError(t, migrations.Run(connStr, zap.NewNop()))

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	repo := repopostgres.NewPolicyRepo(pool)
	eventID := uuid.NewString()
	organizerID := uuid.NewString()
	policy := &repository.AttendancePolicy{
		ID:                  uuid.NewString(),
		EventID:             eventID,
		OrganizerID:         organizerID,
		RequireQRForEntry:   true,
		AllowManualOverride: false,
	}

	require.NoError(t, repo.Upsert(ctx, policy))

	policy.AllowManualOverride = true
	require.NoError(t, repo.Upsert(ctx, policy))

	saved, err := repo.FindByEventID(ctx, eventID)
	require.NoError(t, err)
	require.Equal(t, policy.ID, saved.ID)
	require.Equal(t, eventID, saved.EventID)
	require.Equal(t, organizerID, saved.OrganizerID)
	require.Equal(t, true, saved.RequireQRForEntry)
	require.Equal(t, true, saved.AllowManualOverride)
}
