//go:build integration

package integration_test

import (
	"context"
	"testing"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/search"
	"github.com/acme/ticket-service/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// TestSearch_AvailabilityHydration_SoldOutTicketExcluded seeds ONE sold-out GA
// ticket into OpenSearch, then calls SearchTickets with availableOnly=true and
// asserts zero results are returned.
//
// This is the spec §11 availability-hydration gate test: it proves that
// SearchTickets post-filters hydrated inventory state (sold >= quota for GA
// tickets), independently of the refill-loop tests in search_query_integration_test.go.
func TestSearch_AvailabilityHydration_SoldOutTicketExcluded(t *testing.T) {
	ctx := context.Background()
	url := requireSearchTestURL(t)

	const idx = "tickets_avail_hydration_test"
	deleteTestIndex(t, url, idx)
	t.Cleanup(func() { deleteTestIndex(t, url, idx) })

	c, err := search.NewClient(url, idx, zap.NewNop())
	require.NoError(t, err)
	require.NoError(t, c.EnsureIndex(ctx))

	// Seed ONE sold-out ticket: quota=5, sold=5.
	const soldOutID = "sold-out-only"
	seedDoc(t, c, search.Doc{
		ID:         soldOutID,
		Version:    1,
		EventTitle: "Sold Out Festival",
		Title:      "Sold Out Festival Ticket",
		Price:      120.00,
		Category:   "FESTIVAL",
	})
	refreshIndex(t, url, idx)

	// Fake repo: the ticket is fully sold out.
	repo := newFakeTicketRepo(&repository.Ticket{
		ID:    soldOutID,
		Title: "Sold Out Festival Ticket",
		Quota: 5,
		Sold:  5,
	})

	svc := service.NewTicketService(repo, &noopPublisher{}, zap.NewNop(), &stubVenueClient{}, &stubSavedEventRepo{})
	svc.WithSearchClient(c)

	results, _, _, err := svc.SearchTickets(ctx, repository.PaginationParams{
		Search:        "sold out festival",
		Limit:         10,
		AvailableOnly: true,
	}, "")
	require.NoError(t, err)

	assert.Empty(t, results, "sold-out ticket must be excluded by availableOnly hydration gate")
}
