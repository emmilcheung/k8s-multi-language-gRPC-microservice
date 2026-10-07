package integration_test

import (
	"context"
	"sync"
	"testing"

	"github.com/acme/ticket-service/internal/backfill"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.uber.org/zap"
)

// fakeAccounts stands in for user-service: the same user always gets the same account.
type fakeAccounts struct {
	mu        sync.Mutex
	accountOf map[string]string
	calls     int
}

func newFakeAccounts() *fakeAccounts { return &fakeAccounts{accountOf: map[string]string{}} }

func (f *fakeAccounts) EnsurePersonalAccount(_ context.Context, userID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if id, ok := f.accountOf[userID]; ok {
		return id, nil
	}
	id := uuid.NewString()
	f.accountOf[userID] = id
	return id, nil
}

func startBackfillRepo(t *testing.T) (*repository.MongoTicketRepository, string, string) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err)
	t.Cleanup(func() { _ = mongoContainer.Terminate(ctx) })
	uri, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)
	db := dbName(t.Name())
	repo, err := repository.NewMongoTicketRepository(ctx, uri, db)
	require.NoError(t, err)
	t.Cleanup(func() { _ = repo.Close(ctx) })
	return repo, uri, db
}

func seedTicketsFor(t *testing.T, repo *repository.MongoTicketRepository, owners ...string) []string {
	t.Helper()
	var ids []string
	for _, owner := range owners {
		tk := &repository.Ticket{Title: "Show", Price: "10.00", UserID: owner, Quota: 5, MaxPerUser: 2}
		require.NoError(t, repo.Create(context.Background(), tk))
		ids = append(ids, tk.ID)
	}
	return ids
}

func accountsOf(t *testing.T, repo *repository.MongoTicketRepository, ids []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, id := range ids {
		tk, err := repo.FindByID(context.Background(), id)
		require.NoError(t, err)
		out[id] = tk.AccountID
	}
	return out
}

var backfillOpts = backfill.Options{BatchSize: 2, Log: zap.NewNop()}

func TestBackfillAccounts_ShouldChangeNothing_WhenRunTwice(t *testing.T) {
	repo, _, _ := startBackfillRepo(t)
	ctx := context.Background()
	ids := seedTicketsFor(t, repo, "u1", "u2", "u3", "u1")
	accounts := newFakeAccounts()

	first, err := backfill.Run(ctx, repo, accounts, backfillOpts)
	require.NoError(t, err)
	require.Equal(t, 4, first.Tickets)
	afterFirst := accountsOf(t, repo, ids)
	callsAfterFirst := accounts.calls

	second, err := backfill.Run(ctx, repo, accounts, backfillOpts)
	require.NoError(t, err)

	assert.Equal(t, backfill.Result{}, second)
	assert.Equal(t, afterFirst, accountsOf(t, repo, ids))
	assert.Equal(t, callsAfterFirst, accounts.calls, "no calls to user-service")
}

func TestBackfillAccounts_ShouldAskOncePerOwner_WhenOwnerHasManyTickets(t *testing.T) {
	repo, _, _ := startBackfillRepo(t)
	ids := seedTicketsFor(t, repo, "u1", "u1", "u1", "u2")
	accounts := newFakeAccounts()

	res, err := backfill.Run(context.Background(), repo, accounts, backfillOpts)
	require.NoError(t, err)

	assert.Equal(t, 2, res.Owners)
	assert.Equal(t, 2, accounts.calls, "one personal account request per distinct owner")
	got := accountsOf(t, repo, ids)
	assert.Equal(t, accounts.accountOf["u1"], got[ids[0]])
	assert.Equal(t, accounts.accountOf["u1"], got[ids[2]])
	assert.Equal(t, accounts.accountOf["u2"], got[ids[3]])
}

func TestBackfillAccounts_ShouldKeepCreatorAndLetThemEdit_WhenTicketHasAnAccount(t *testing.T) {
	repo, _, _ := startBackfillRepo(t)
	ctx := context.Background()
	id := seedTicketsFor(t, repo, "u1")[0]

	_, err := backfill.Run(ctx, repo, newFakeAccounts(), backfillOpts)
	require.NoError(t, err)

	tk, err := repo.FindByID(ctx, id)
	require.NoError(t, err)
	require.NotEmpty(t, tk.AccountID)
	assert.Equal(t, "u1", tk.UserID, "created-by is untouched")
	assert.Equal(t, 1, tk.Version, "the backfill is not an edit")

	tk.Title = "Renamed"
	require.NoError(t, repo.Update(ctx, tk))
	again, err := repo.FindByID(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, "Renamed", again.Title)
	assert.Equal(t, tk.AccountID, again.AccountID, "an edit does not drop the account")
}

func TestBackfillAccounts_ShouldOnlyCount_WhenDryRun(t *testing.T) {
	repo, _, _ := startBackfillRepo(t)
	ids := seedTicketsFor(t, repo, "u1", "u1", "u2")
	accounts := newFakeAccounts()
	opts := backfillOpts
	opts.DryRun = true

	res, err := backfill.Run(context.Background(), repo, accounts, opts)
	require.NoError(t, err)

	assert.Equal(t, backfill.Result{Tickets: 3, Owners: 2}, res)
	assert.Zero(t, accounts.calls)
	for _, a := range accountsOf(t, repo, ids) {
		assert.Empty(t, a)
	}
}

func TestBackfillAccounts_ShouldResume_WhenInterruptedMidway(t *testing.T) {
	repo, _, _ := startBackfillRepo(t)
	ids := seedTicketsFor(t, repo, "u1", "u2", "u3", "u4", "u5")
	ctx, cancel := context.WithCancel(context.Background())
	opts := backfillOpts
	opts.OnProgress = func(backfill.Result) { cancel() } // stop after the first batch

	_, err := backfill.Run(ctx, repo, newFakeAccounts(), opts)
	require.ErrorIs(t, err, context.Canceled)

	res, err := backfill.Run(context.Background(), repo, newFakeAccounts(), backfillOpts)
	require.NoError(t, err)
	assert.Equal(t, 3, res.Tickets, "only the tickets the first run did not reach")
	for _, a := range accountsOf(t, repo, ids) {
		assert.NotEmpty(t, a)
	}
}

func TestRepository_ShouldIndexTicketsByAccount(t *testing.T) {
	_, uri, db := startBackfillRepo(t)
	ctx := context.Background()
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Disconnect(ctx) })

	names, err := client.Database(db).Collection("tickets").Indexes().ListSpecifications(ctx)
	require.NoError(t, err)

	var found []string
	for _, n := range names {
		found = append(found, n.Name)
	}
	assert.Contains(t, found, "idx_accountId")
}
