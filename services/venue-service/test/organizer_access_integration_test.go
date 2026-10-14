package test

import (
	"context"
	"errors"
	"testing"

	"github.com/acme/venue-service/internal/audit"
	"github.com/acme/venue-service/internal/authz"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/acme/venue-service/internal/security"
	"github.com/acme/venue-service/internal/service"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestOrganizerAccess_NewVenuesStartUnverifiedAndRecordTheirCreatorAccount(t *testing.T) {
	pool := startBackfillPool(t)
	ctx := context.Background()
	repo := pgrepo.NewVenueRepo(pool)
	account := uuid.NewString()

	v := &repository.Venue{OrganizerID: user1, Name: "Hall", Capacity: 10, Timezone: "UTC", CreatedByAccountID: account}
	require.NoError(t, repo.Create(ctx, v))
	assert.Equal(t, repository.VenueStatusUnverified, v.Status)

	got, err := repo.FindByID(ctx, v.ID)
	require.NoError(t, err)
	assert.Equal(t, account, got.CreatedByAccountID)

	// Without a verified account (log mode, no header) the column stays NULL.
	bare := &repository.Venue{OrganizerID: user1, Name: "Bare", Capacity: 10, Timezone: "UTC"}
	require.NoError(t, repo.Create(ctx, bare))
	got, err = repo.FindByID(ctx, bare.ID)
	require.NoError(t, err)
	assert.Empty(t, got.CreatedByAccountID)

	// Migration 010: a row inserted by anything that omits the status is unverified.
	var status string
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO venues (organizer_id, name, capacity, timezone) VALUES ('00000000-0000-0000-0000-000000000002','Raw',1,'UTC') RETURNING status`).Scan(&status))
	assert.Equal(t, "UNVERIFIED", status)
}

// The venue change and its audit row are one transaction: when the audit write
// fails the venue must not exist, and when the change succeeds both exist.
func TestOrganizerAccess_TheChangeAndItsAuditRowCommitTogether(t *testing.T) {
	pool := startBackfillPool(t)
	ctx := context.Background()
	repo := pgrepo.NewVenueRepo(pool)
	access := service.NewOrganizerAccess(allowEverything{}, authz.ModeLog, nil, pgrepo.NewTxRunner(pool), zap.NewNop())

	ok := &repository.Venue{OrganizerID: user1, Name: "Kept", Capacity: 10, Timezone: "UTC"}
	err := access.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, user1, "", service.ActionVenueCreate, "venue:"+ok.ID, nil, service.VenueFields(ok))
	}, func(ctx context.Context) error { return repo.Create(ctx, ok) })
	require.NoError(t, err)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE resource = $1`, "venue:"+ok.ID).Scan(&n))
	assert.Equal(t, 1, n)

	lost := &repository.Venue{OrganizerID: user1, Name: "Lost", Capacity: 10, Timezone: "UTC"}
	boom := errors.New("later step failed")
	err = access.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, user1, "", service.ActionVenueCreate, "venue:"+lost.ID, nil, service.VenueFields(lost))
	}, func(ctx context.Context) error {
		if err := repo.Create(ctx, lost); err != nil {
			return err
		}
		return boom
	})
	require.ErrorIs(t, err, boom)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM venues WHERE name = 'Lost'`).Scan(&n))
	assert.Zero(t, n, "a rolled-back change leaves no venue behind")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE resource = $1`, "venue:"+lost.ID).Scan(&n))
	assert.Zero(t, n)

}

const user1 = "00000000-0000-0000-0000-000000000001"

type allowEverything struct{}

func (allowEverything) Check(context.Context, security.TrustedCaller, string, authz.Scope) (authz.Decision, error) {
	return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
}
