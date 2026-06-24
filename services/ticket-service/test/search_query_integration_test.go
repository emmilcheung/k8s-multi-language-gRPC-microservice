//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/99designs/gqlgen/graphql/handler"
	graph "github.com/acme/ticket-service/internal/graphql"
	"github.com/acme/ticket-service/internal/config"
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

	// ── Seed: 2 sold-out + 3 available tickets for the refill loop test ─────────
	// All 5 share equal relevance score (same EventTitle match on "concert").
	// OpenSearch breaks score ties by _id ascending, so 'a'-prefixed ids rank
	// before 'b'-prefixed ids.  The 2 sold-out tickets (a0, a1) therefore appear
	// at the top of every search page.
	//
	// The AvailableOnly filter is applied inside SearchTickets (post-hydration),
	// so OS returns raw hits [a0,a1,b0] on the first call (limit=3).  After
	// filtering, only b0 survives and afterCursor advances to b0's cursor.
	// The resolver's refill loop then issues a second call (after=b0's cursor)
	// which returns [b1,b2] — both available — completing the page.
	//
	// Without the refill loop a single SearchTickets(limit=3) call would return
	// only b0 (1 item) and the page would never reach the requested 3 items.
	allTickets := []*repository.Ticket{ticketA, ticketB}
	soldOutIDs := []string{"a0", "a1"}
	for _, id := range soldOutIDs {
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
	availIDs := []string{"b0", "b1", "b2"}
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

	// ── Assert 2: resolver refill loop surfaces available tickets past sold-out leaders ─
	// The refill loop lives in the resolver's TicketsConnection, NOT in SearchTickets.
	// Drive the test through the resolver so we genuinely exercise the refill path.
	// (Without the refill loop, the first SearchTickets call returns only a00..a02,
	// all sold-out, and availableOnly post-filtering yields an empty result.)
	resolver := &graph.Resolver{
		TicketService: svc,
		Config: &config.Config{
			SearchBackend: "opensearch",
		},
		Log: zap.NewNop(),
	}
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: resolver})
	srv := handler.NewDefaultServer(schema)

	body := `{"query":"{ ticketsConnection(filter: { search: \"concert\", availableOnly: true }, first: 3) { edges { node { id } } pageInfo { hasNextPage endCursor } } }"}`
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req.WithContext(ctx))

	require.Equal(t, http.StatusOK, w.Code, "graphql response must be 200")

	var gqlResp struct {
		Data struct {
			TicketsConnection struct {
				Edges []struct {
					Node struct {
						ID string `json:"id"`
					} `json:"node"`
				} `json:"edges"`
				PageInfo struct {
					HasNextPage bool    `json:"hasNextPage"`
					EndCursor   *string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"ticketsConnection"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	require.NoError(t, json.NewDecoder(w.Body).Decode(&gqlResp), "response must be valid JSON")
	require.Empty(t, gqlResp.Errors, "no GraphQL errors expected: %v", gqlResp.Errors)

	edges := gqlResp.Data.TicketsConnection.Edges
	require.Len(t, edges, 3, "refill loop must surface exactly 3 available tickets")

	// All returned IDs must be from the available set (b0..b2), not sold-out (a0,a1).
	availSet := map[string]bool{"b0": true, "b1": true, "b2": true}
	for _, e := range edges {
		require.True(t, availSet[e.Node.ID],
			"returned ticket %q must be available (not sold-out)", e.Node.ID)
	}
}
