//go:build integration

package integration_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/search"
	"github.com/acme/ticket-service/internal/service"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// ── fake repository ──────────────────────────────────────────────────────────

// fakeTicketRepo is a minimal TicketRepository stub used by the search query
// integration test. Only FindByIDs is required; all other methods panic to
// surface accidental calls during test runs.
type fakeTicketRepo struct {
	tickets map[string]*repository.Ticket
}

func newFakeTicketRepo(tickets ...*repository.Ticket) *fakeTicketRepo {
	m := make(map[string]*repository.Ticket, len(tickets))
	for _, t := range tickets {
		m[t.ID] = t
	}
	return &fakeTicketRepo{tickets: m}
}

func (f *fakeTicketRepo) FindByIDs(_ context.Context, ids []string) ([]*repository.Ticket, error) {
	out := make([]*repository.Ticket, len(ids))
	for i, id := range ids {
		out[i] = f.tickets[id] // nil if not seeded
	}
	return out, nil
}

func (f *fakeTicketRepo) Create(_ context.Context, _ *repository.Ticket) error {
	panic("fakeTicketRepo: Create not implemented")
}
func (f *fakeTicketRepo) FindByID(_ context.Context, _ string) (*repository.Ticket, error) {
	panic("fakeTicketRepo: FindByID not implemented")
}
func (f *fakeTicketRepo) FindAll(_ context.Context, _ repository.PaginationParams) ([]*repository.Ticket, error) {
	panic("fakeTicketRepo: FindAll not implemented")
}
func (f *fakeTicketRepo) Update(_ context.Context, _ *repository.Ticket) error {
	panic("fakeTicketRepo: Update not implemented")
}
func (f *fakeTicketRepo) ReserveTicket(_ context.Context, _, _ string) error {
	panic("fakeTicketRepo: ReserveTicket not implemented")
}
func (f *fakeTicketRepo) ReleaseTicket(_ context.Context, _ string) error {
	panic("fakeTicketRepo: ReleaseTicket not implemented")
}
func (f *fakeTicketRepo) CreateReservation(_ context.Context, _ *repository.TicketReservation) error {
	panic("fakeTicketRepo: CreateReservation not implemented")
}
func (f *fakeTicketRepo) FindReservationByID(_ context.Context, _ string) (*repository.TicketReservation, error) {
	panic("fakeTicketRepo: FindReservationByID not implemented")
}
func (f *fakeTicketRepo) ReleaseReservation(_ context.Context, _ string) error {
	panic("fakeTicketRepo: ReleaseReservation not implemented")
}
func (f *fakeTicketRepo) FinalizeReservation(_ context.Context, _, _ string) error {
	panic("fakeTicketRepo: FinalizeReservation not implemented")
}
func (f *fakeTicketRepo) Ping(_ context.Context) error { return nil }
func (f *fakeTicketRepo) Close(_ context.Context) error { return nil }

// ── helpers ──────────────────────────────────────────────────────────────────

// requireSearchTestURL returns OPENSEARCH_TEST_URL or skips the test.
func requireSearchTestURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("OPENSEARCH_TEST_URL")
	if url == "" {
		t.Skip("set OPENSEARCH_TEST_URL to run OpenSearch query integration tests (e.g. OPENSEARCH_TEST_URL=http://localhost:9200)")
	}
	return url
}

// seedDoc upserts a Doc into the index and waits briefly so the document is
// visible to subsequent searches (OpenSearch is near-real-time).
func seedDoc(t *testing.T, c *search.Client, doc search.Doc) {
	t.Helper()
	require.NoError(t, c.UpsertTicket(context.Background(), doc))
}

// refreshIndex forces a synchronous refresh of the index so all seeded documents
// are immediately visible to search. Uses the _refresh HTTP API endpoint.
func refreshIndex(t *testing.T, url, index string) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url+"/"+index+"/_refresh", http.NoBody)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close() //nolint:errcheck
	require.Equal(t, http.StatusOK, resp.StatusCode, "index refresh failed")
}

// ── tests ─────────────────────────────────────────────────────────────────────

func TestSearch_TypoAndBoostAndRefill(t *testing.T) {
	ctx := context.Background()
	url := requireSearchTestURL(t)

	const idx = "tickets_query_test"
	deleteTestIndex(t, url, idx)
	t.Cleanup(func() { deleteTestIndex(t, url, idx) })

	c, err := search.NewClient(url, idx, zap.NewNop())
	require.NoError(t, err)
	require.NoError(t, c.EnsureIndex(ctx))

	// ── Seed: two tickets for typo + boost test ───────────────────────────────
	// Ticket "A": eventTitle matches "Taylor Swift Eras" → should rank first due
	// to eventTitle^3 boost even with the typo "swfit".
	ticketA := &repository.Ticket{
		ID:    "A",
		Title: "Taylor Swift Eras Tour",
		Quota: 10,
		Sold:  0,
	}
	seedDoc(t, c, search.Doc{
		ID:         "A",
		Version:    1,
		EventTitle: "Taylor Swift Eras",
		Title:      "Taylor Swift Eras Tour",
		Price:      99.00,
		Category:   "CONCERT",
	})

	// Ticket "B": only description contains "swift boat" → lower relevance.
	ticketB := &repository.Ticket{
		ID:    "B",
		Title: "River Cruise",
		Quota: 10,
		Sold:  0,
	}
	seedDoc(t, c, search.Doc{
		ID:          "B",
		Version:     1,
		Title:       "River Cruise",
		Description: "Enjoy a swift boat ride down the river",
		Price:       50.00,
		Category:    "OTHER",
	})

	// ── Seed: 25 sold-out "concert" tickets + 3 available ones ───────────────
	// The 25 sold-out tickets will rank at the top for the "concert" query.
	// SearchTickets must skip them and still surface 3 available tickets.
	const soldOutCount = 25
	allTickets := []*repository.Ticket{ticketA, ticketB}
	for i := 0; i < soldOutCount; i++ {
		id := fmt.Sprintf("soldout-%d", i)
		allTickets = append(allTickets, &repository.Ticket{
			ID:    id,
			Title: "Sold Out Concert",
			Quota: 5,
			Sold:  5, // fully sold out
		})
		seedDoc(t, c, search.Doc{
			ID:         id,
			Version:    1,
			EventTitle: "Grand Concert Series",
			Title:      "Sold Out Concert",
			Price:      80.00,
			Category:   "CONCERT",
		})
	}
	availIDs := []string{"avail-0", "avail-1", "avail-2"}
	for i, id := range availIDs {
		allTickets = append(allTickets, &repository.Ticket{
			ID:    id,
			Title: fmt.Sprintf("Available Concert %d", i),
			Quota: 10,
			Sold:  0,
		})
		seedDoc(t, c, search.Doc{
			ID:         id,
			Version:    1,
			EventTitle: "Grand Concert Series",
			Title:      fmt.Sprintf("Available Concert %d", i),
			Price:      80.00,
			Category:   "CONCERT",
		})
	}

	refreshIndex(t, url, idx)

	// Build service with real search client + fake repo.
	repo := newFakeTicketRepo(allTickets...)
	svc := service.NewTicketService(repo, &noopPublisher{}, zap.NewNop(), &stubVenueClient{}, &stubSavedEventRepo{})
	svc.WithSearchClient(c)

	// ── Assert 1: typo-tolerant search ranks A before B ──────────────────────
	res, exhausted, err := svc.SearchTickets(ctx, repository.PaginationParams{Search: "swfit", Limit: 10}, "")
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(res), 1, "expected at least one result")
	require.Equal(t, "A", res[0].Ticket.ID, "eventTitle-boosted ticket must rank first")
	_ = exhausted

	// ── Assert 2: availableOnly must return a full page despite sold-out hits ─
	// Limit=3: SearchTickets iterates until it finds 3 available tickets.
	avail, _, err := svc.SearchTickets(ctx, repository.PaginationParams{Search: "concert", AvailableOnly: true, Limit: 3}, "")
	require.NoError(t, err)
	require.Len(t, avail, 3, "availableOnly must return exactly 3 available tickets")
	for _, r := range avail {
		require.True(t, r.Ticket.Sold < r.Ticket.Quota || r.Ticket.SeatingPlanID != "",
			"every returned ticket must be available")
	}
}
