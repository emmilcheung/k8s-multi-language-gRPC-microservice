package test

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/acme/venue-service/internal/backfill"
	"github.com/acme/venue-service/internal/migrations"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

// fakeAccounts stands in for user-service. Like the real one it answers the
// same account for the same user and keeps one manager membership per venue.
type fakeAccounts struct {
	mu            sync.Mutex
	accountOf     map[string]string
	personalCalls int
	managerCalls  int
	managers      map[string]string // venue id -> user id
}

func newFakeAccounts() *fakeAccounts {
	return &fakeAccounts{accountOf: map[string]string{}, managers: map[string]string{}}
}

func (f *fakeAccounts) EnsurePersonalAccount(_ context.Context, userID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.personalCalls++
	if id, ok := f.accountOf[userID]; ok {
		return id, nil
	}
	id := uuid.NewString()
	f.accountOf[userID] = id
	return id, nil
}

func (f *fakeAccounts) EnsureVenueManager(_ context.Context, userID, venueID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.managerCalls++
	f.managers[venueID] = userID
	return nil
}

func startBackfillPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pg, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("venue_test"),
		tcpostgres.WithUsername("venue_user"),
		tcpostgres.WithPassword("venue_pass"),
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

func seedVenues(t *testing.T, repo *pgrepo.VenueRepo, owners ...string) []*repository.Venue {
	t.Helper()
	var out []*repository.Venue
	for i, owner := range owners {
		v := &repository.Venue{OrganizerID: owner, Name: fmt.Sprintf("Venue %d", i), Capacity: 100, Timezone: "UTC"}
		require.NoError(t, repo.Create(context.Background(), v))
		out = append(out, v)
	}
	return out
}

type venueRow struct {
	Status    string
	AccountID *string
	Owner     string
}

func venueRows(t *testing.T, pool *pgxpool.Pool) map[string]venueRow {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT id::text, status, created_by_account_id::text, organizer_id::text FROM venues`)
	require.NoError(t, err)
	defer rows.Close()
	out := map[string]venueRow{}
	for rows.Next() {
		var id string
		var r venueRow
		require.NoError(t, rows.Scan(&id, &r.Status, &r.AccountID, &r.Owner))
		out[id] = r
	}
	require.NoError(t, rows.Err())
	return out
}

var backfillOpts = backfill.Options{BatchSize: 2, Log: zap.NewNop()}

func TestBackfillAccounts_ShouldChangeNothing_WhenRunTwice(t *testing.T) {
	pool := startBackfillPool(t)
	ctx := context.Background()
	repo := pgrepo.NewVenueRepo(pool)
	seedVenues(t, repo, uuid.NewString(), uuid.NewString(), uuid.NewString())
	accounts := newFakeAccounts()

	first, err := backfill.Run(ctx, pool, accounts, backfillOpts)
	require.NoError(t, err)
	require.Equal(t, 3, first.Venues)
	afterFirst := venueRows(t, pool)
	callsAfterFirst := accounts.personalCalls + accounts.managerCalls

	second, err := backfill.Run(ctx, pool, accounts, backfillOpts)
	require.NoError(t, err)

	assert.Equal(t, 0, second.Venues, "nothing is left to do")
	assert.Equal(t, afterFirst, venueRows(t, pool))
	assert.Equal(t, callsAfterFirst, accounts.personalCalls+accounts.managerCalls, "no calls to user-service")
}

func TestBackfillAccounts_ShouldAskOncePerOwner_WhenOwnerHasManyVenues(t *testing.T) {
	pool := startBackfillPool(t)
	repo := pgrepo.NewVenueRepo(pool)
	ada, bob := uuid.NewString(), uuid.NewString()
	seedVenues(t, repo, ada, ada, ada, bob)
	accounts := newFakeAccounts()

	res, err := backfill.Run(context.Background(), pool, accounts, backfillOpts)
	require.NoError(t, err)

	assert.Equal(t, 2, res.Owners)
	assert.Equal(t, 2, accounts.personalCalls, "one personal account request per distinct owner")
	for _, r := range venueRows(t, pool) {
		require.NotNil(t, r.AccountID)
		assert.Equal(t, accounts.accountOf[r.Owner], *r.AccountID, "venue belongs to its creator's personal account")
		assert.Equal(t, "VERIFIED", r.Status)
	}
	assert.Equal(t, 4, accounts.managerCalls, "every venue gets its creator as venue manager")
}

func TestBackfillAccounts_ShouldLeaveCreatorAbleToEditVenue(t *testing.T) {
	pool := startBackfillPool(t)
	ctx := context.Background()
	repo := pgrepo.NewVenueRepo(pool)
	owner := uuid.NewString()
	v := seedVenues(t, repo, owner)[0]

	_, err := backfill.Run(ctx, pool, newFakeAccounts(), backfillOpts)
	require.NoError(t, err)

	v.Name = "Renamed after backfill"
	require.NoError(t, repo.Update(ctx, v), "the creator's edit still goes through")
	got, err := repo.FindByID(ctx, v.ID)
	require.NoError(t, err)
	assert.Equal(t, "Renamed after backfill", got.Name)
	assert.Equal(t, owner, got.OrganizerID, "created-by is untouched")

	stranger := *v
	stranger.OrganizerID = uuid.NewString()
	stranger.Name = "Hijacked"
	assert.ErrorIs(t, repo.Update(ctx, &stranger), repository.ErrVenueNotFound, "someone else still cannot edit")
}

func TestBackfillAccounts_ShouldOnlyCount_WhenDryRun(t *testing.T) {
	pool := startBackfillPool(t)
	repo := pgrepo.NewVenueRepo(pool)
	ada := uuid.NewString()
	seedVenues(t, repo, ada, ada, uuid.NewString())
	accounts := newFakeAccounts()
	opts := backfillOpts
	opts.DryRun = true

	res, err := backfill.Run(context.Background(), pool, accounts, opts)
	require.NoError(t, err)

	assert.Equal(t, 3, res.Venues)
	assert.Equal(t, 2, res.Owners)
	assert.Zero(t, accounts.personalCalls+accounts.managerCalls)
	for _, r := range venueRows(t, pool) {
		assert.Nil(t, r.AccountID)
	}
}

func TestBackfillAccounts_ShouldResume_WhenInterruptedMidway(t *testing.T) {
	pool := startBackfillPool(t)
	repo := pgrepo.NewVenueRepo(pool)
	seedVenues(t, repo, uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString())
	ctx, cancel := context.WithCancel(context.Background())
	opts := backfillOpts
	opts.OnProgress = func(backfill.Result) { cancel() } // stop after the first batch

	_, err := backfill.Run(ctx, pool, newFakeAccounts(), opts)
	require.ErrorIs(t, err, context.Canceled)

	res, err := backfill.Run(context.Background(), pool, newFakeAccounts(), backfillOpts)
	require.NoError(t, err)
	assert.Equal(t, 3, res.Venues, "only the venues the first run did not reach")
	for _, r := range venueRows(t, pool) {
		assert.NotNil(t, r.AccountID)
	}
}

func TestMigrations_ShouldMarkVenuesVerified_AndLeaveAccountEmpty(t *testing.T) {
	pool := startBackfillPool(t)
	seedVenues(t, pgrepo.NewVenueRepo(pool), uuid.NewString())

	for _, r := range venueRows(t, pool) {
		assert.Equal(t, "VERIFIED", r.Status)
		assert.Nil(t, r.AccountID)
	}
}
