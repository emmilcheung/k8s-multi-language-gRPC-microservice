package service_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/search"
	"github.com/acme/ticket-service/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// stubSearchRepo is a minimal TicketRepository that only implements FindByIDs.
// All other methods panic to surface accidental calls.
type stubSearchRepo struct {
	tickets map[string]*repository.Ticket
}

func newStubSearchRepo(tickets ...*repository.Ticket) *stubSearchRepo {
	m := make(map[string]*repository.Ticket, len(tickets))
	for _, t := range tickets {
		m[t.ID] = t
	}
	return &stubSearchRepo{tickets: m}
}

func (s *stubSearchRepo) FindByIDs(_ context.Context, ids []string) ([]*repository.Ticket, error) {
	out := make([]*repository.Ticket, len(ids))
	for i, id := range ids {
		out[i] = s.tickets[id]
	}
	return out, nil
}

func (s *stubSearchRepo) Create(_ context.Context, _ *repository.Ticket) error {
	panic("stubSearchRepo: Create not implemented")
}
func (s *stubSearchRepo) FindByID(_ context.Context, _ string) (*repository.Ticket, error) {
	panic("stubSearchRepo: FindByID not implemented")
}
func (s *stubSearchRepo) FindAll(_ context.Context, _ repository.PaginationParams) ([]*repository.Ticket, error) {
	panic("stubSearchRepo: FindAll not implemented")
}
func (s *stubSearchRepo) Update(_ context.Context, _ *repository.Ticket) error {
	panic("stubSearchRepo: Update not implemented")
}
func (s *stubSearchRepo) ReserveTicket(_ context.Context, _, _ string) error {
	panic("stubSearchRepo: ReserveTicket not implemented")
}
func (s *stubSearchRepo) ReleaseTicket(_ context.Context, _ string) error {
	panic("stubSearchRepo: ReleaseTicket not implemented")
}
func (s *stubSearchRepo) CreateReservation(_ context.Context, _ *repository.TicketReservation) error {
	panic("stubSearchRepo: CreateReservation not implemented")
}
func (s *stubSearchRepo) FindReservationByID(_ context.Context, _ string) (*repository.TicketReservation, error) {
	panic("stubSearchRepo: FindReservationByID not implemented")
}
func (s *stubSearchRepo) ReleaseReservation(_ context.Context, _ string) error {
	panic("stubSearchRepo: ReleaseReservation not implemented")
}
func (s *stubSearchRepo) FinalizeReservation(_ context.Context, _, _ string) error {
	panic("stubSearchRepo: FinalizeReservation not implemented")
}
func (s *stubSearchRepo) Ping(_ context.Context) error { return nil }
func (s *stubSearchRepo) Close(_ context.Context) error { return nil }

// buildOSResponse constructs a minimal OpenSearch _search response JSON with
// the given hit IDs and scores for use with an httptest server.
func buildOSResponse(hits []struct {
	id    string
	score float64
}) []byte {
	type hitDoc struct {
		ID   string `json:"_id"`
		Sort []any  `json:"sort"`
	}
	type hitsWrapper struct {
		Hits []hitDoc `json:"hits"`
	}
	type resp struct {
		Hits hitsWrapper `json:"hits"`
	}
	r := resp{}
	for _, h := range hits {
		r.Hits.Hits = append(r.Hits.Hits, hitDoc{ID: h.id, Sort: []any{h.score, h.id}})
	}
	b, _ := json.Marshal(r)
	return b
}

// newOSTestServer returns an httptest.Server that responds to _search requests
// with the given JSON body for any _search call.
func newOSTestServer(t *testing.T, responseBody []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(responseBody)
	}))
}

// TestSearchTickets_AvailableOnly_PostFiltersGA verifies that GA tickets with
// sold >= quota are excluded when AvailableOnly=true, and available tickets survive.
func TestSearchTickets_AvailableOnly_PostFiltersGA(t *testing.T) {
	// Two hits from OS: "sold-out" (sold=quota) and "available" (sold<quota).
	osHits := []struct {
		id    string
		score float64
	}{
		{id: "sold-out", score: 2.0},
		{id: "available", score: 1.5},
	}
	srv := newOSTestServer(t, buildOSResponse(osHits))
	defer srv.Close()

	repo := newStubSearchRepo(
		&repository.Ticket{ID: "sold-out", Quota: 5, Sold: 5},
		&repository.Ticket{ID: "available", Quota: 5, Sold: 2},
	)

	sc, err := search.NewClient(srv.URL, "test-idx", zap.NewNop())
	require.NoError(t, err)

	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, newMockSavedEventRepo())
	svc.WithSearchClient(sc)

	results, _, _, err := svc.SearchTickets(t.Context(), repository.PaginationParams{
		Search:        "concert",
		Limit:         10,
		AvailableOnly: true,
	}, "")
	require.NoError(t, err)

	require.Len(t, results, 1, "sold-out GA ticket must be filtered")
	assert.Equal(t, "available", results[0].Ticket.ID)
}

// TestSearchTickets_AvailableOnly_SeatedPassThrough verifies that seated tickets
// (SeatingPlanID != "") pass the availableOnly filter regardless of sold/quota,
// because venue-service manages their inventory.
func TestSearchTickets_AvailableOnly_SeatedPassThrough(t *testing.T) {
	osHits := []struct {
		id    string
		score float64
	}{
		{id: "seated", score: 2.0},
	}
	srv := newOSTestServer(t, buildOSResponse(osHits))
	defer srv.Close()

	repo := newStubSearchRepo(
		// Seated ticket with sold=quota but SeatingPlanID set — must still pass.
		&repository.Ticket{ID: "seated", Quota: 0, Sold: 0, SeatingPlanID: "plan-1"},
	)

	sc, err := search.NewClient(srv.URL, "test-idx", zap.NewNop())
	require.NoError(t, err)

	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, newMockSavedEventRepo())
	svc.WithSearchClient(sc)

	results, _, _, err := svc.SearchTickets(t.Context(), repository.PaginationParams{
		Search:        "concert",
		Limit:         10,
		AvailableOnly: true,
	}, "")
	require.NoError(t, err)
	require.Len(t, results, 1, "seated ticket must pass availableOnly regardless of quota")
	assert.Equal(t, "seated", results[0].Ticket.ID)
}

// TestSearchTickets_CursorBuilding verifies that the "os:<score>:<id>" cursor is
// built from the OpenSearch sort tuple for each hit, and nextCursor uses the last
// raw hit (pre-filter).
func TestSearchTickets_CursorBuilding(t *testing.T) {
	osHits := []struct {
		id    string
		score float64
	}{
		{id: "t1", score: 3.5},
		{id: "t2", score: 1.0},
	}
	srv := newOSTestServer(t, buildOSResponse(osHits))
	defer srv.Close()

	repo := newStubSearchRepo(
		&repository.Ticket{ID: "t1", Quota: 5, Sold: 0},
		&repository.Ticket{ID: "t2", Quota: 5, Sold: 0},
	)

	sc, err := search.NewClient(srv.URL, "test-idx", zap.NewNop())
	require.NoError(t, err)

	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, newMockSavedEventRepo())
	svc.WithSearchClient(sc)

	results, nextCursor, _, err := svc.SearchTickets(t.Context(), repository.PaginationParams{
		Search: "concert",
		Limit:  10,
	}, "")
	require.NoError(t, err)
	require.Len(t, results, 2)

	// Per-result cursors encode the sort score.
	assert.Equal(t, "os:3.5:t1", results[0].Cursor)
	assert.Equal(t, "os:1:t2", results[1].Cursor)

	// nextCursor is the last raw hit cursor (t2).
	assert.Equal(t, fmt.Sprintf("os:1:t2"), nextCursor)
}

// TestSearchTickets_NoSearchClient_ReturnsError verifies that calling
// SearchTickets without wiring up a search client returns an error.
func TestSearchTickets_NoSearchClient_ReturnsError(t *testing.T) {
	repo := newStubSearchRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, newMockSavedEventRepo())
	// No WithSearchClient call.

	_, _, _, err := svc.SearchTickets(t.Context(), repository.PaginationParams{Search: "x", Limit: 5}, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "search client not configured")
}
