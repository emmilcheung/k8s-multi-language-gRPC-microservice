//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/search"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// fakeReindexRepo is a stub TicketRepository whose FindAll returns the seeded
// tickets in a single page (no cursor paging needed for the test). All other
// methods panic to surface accidental calls during the test run.
type fakeReindexRepo struct {
	tickets []*repository.Ticket
	called  bool // guard: FindAll is called at most once (empty cursor)
}

func (f *fakeReindexRepo) FindAll(_ context.Context, p repository.PaginationParams) ([]*repository.Ticket, error) {
	if f.called {
		// Second call means cursor paging — return empty to signal end of data.
		return nil, nil
	}
	f.called = true
	return f.tickets, nil
}

func (f *fakeReindexRepo) Create(_ context.Context, _ *repository.Ticket) error {
	panic("fakeReindexRepo: Create not implemented")
}
func (f *fakeReindexRepo) FindByID(_ context.Context, _ string) (*repository.Ticket, error) {
	panic("fakeReindexRepo: FindByID not implemented")
}
func (f *fakeReindexRepo) FindByIDs(_ context.Context, _ []string) ([]*repository.Ticket, error) {
	panic("fakeReindexRepo: FindByIDs not implemented")
}
func (f *fakeReindexRepo) Update(_ context.Context, _ *repository.Ticket) error {
	panic("fakeReindexRepo: Update not implemented")
}
func (f *fakeReindexRepo) ReserveTicket(_ context.Context, _, _ string) error {
	panic("fakeReindexRepo: ReserveTicket not implemented")
}
func (f *fakeReindexRepo) ReleaseTicket(_ context.Context, _ string) error {
	panic("fakeReindexRepo: ReleaseTicket not implemented")
}
func (f *fakeReindexRepo) CreateReservation(_ context.Context, _ *repository.TicketReservation) error {
	panic("fakeReindexRepo: CreateReservation not implemented")
}
func (f *fakeReindexRepo) FindReservationByID(_ context.Context, _ string) (*repository.TicketReservation, error) {
	panic("fakeReindexRepo: FindReservationByID not implemented")
}
func (f *fakeReindexRepo) ReleaseReservation(_ context.Context, _ string) error {
	panic("fakeReindexRepo: ReleaseReservation not implemented")
}
func (f *fakeReindexRepo) FinalizeReservation(_ context.Context, _, _ string) error {
	panic("fakeReindexRepo: FinalizeReservation not implemented")
}
func (f *fakeReindexRepo) Ping(_ context.Context) error { return nil }
func (f *fakeReindexRepo) Close(_ context.Context) error { return nil }

// countDocs returns the number of documents in the given index via the count API.
func countDocs(t *testing.T, url, index string) int64 {
	t.Helper()

	// Force a refresh so all buffered writes are visible.
	refreshIndex(t, url, index)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url+"/"+index+"/_count", http.NoBody)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close() //nolint:errcheck

	var body struct {
		Count int64 `json:"count"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	return body.Count
}

// requireOpenSearchAPIClient builds a low-level OpenSearch API client for the given URL.
func requireOpenSearchAPIClient(t *testing.T, url string) *opensearchapi.Client {
	t.Helper()
	api, err := opensearchapi.NewClient(opensearchapi.Config{
		Client: opensearch.Config{Addresses: []string{url}},
	})
	require.NoError(t, err)
	return api
}

func TestReindex_PopulatesIndexFromMongo(t *testing.T) {
	ctx := context.Background()
	url := requireSearchTestURL(t)

	const idx = "tickets_reindex_test"
	deleteTestIndex(t, url, idx)
	t.Cleanup(func() { deleteTestIndex(t, url, idx) })

	c, err := search.NewClient(url, idx, zap.NewNop())
	require.NoError(t, err)
	require.NoError(t, c.EnsureIndex(ctx))

	now := time.Now().UTC()
	repo := &fakeReindexRepo{
		tickets: []*repository.Ticket{
			{
				ID:        "r1",
				Title:     "Rock Concert",
				Price:     "50.00",
				UserID:    "u1",
				Category:  "CONCERT",
				Quota:     100,
				Sold:      0,
				Version:   1,
				CreatedAt: now.Add(-3 * time.Hour),
				Event: &repository.TicketEvent{
					Title:        "Rock Night",
					VenueName:    "Arena",
					VenueAddress: "123 Main St",
					StartsAt:     now.Add(24 * time.Hour),
				},
			},
			{
				ID:        "r2",
				Title:     "Jazz Evening",
				Price:     "30.00",
				UserID:    "u2",
				Category:  "OTHER",
				Quota:     50,
				Sold:      5,
				Version:   2,
				CreatedAt: now.Add(-2 * time.Hour),
			},
			{
				ID:        "r3",
				Title:     "Comedy Show",
				Price:     "20.00",
				UserID:    "u3",
				Category:  "COMEDY",
				Quota:     200,
				Sold:      10,
				Version:   3,
				CreatedAt: now.Add(-1 * time.Hour),
			},
		},
	}

	require.NoError(t, search.Reindex(ctx, repo, c, 500))
	require.Equal(t, int64(3), countDocs(t, url, idx))
}
