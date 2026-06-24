//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/search"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// fakeReindexRepo implements search.TicketRepository only — FindAll with real cursor
// paging, mirroring MongoTicketRepository.FindAll's out-of-range fallback behaviour.
// Tickets are stored in newest-first order (descending createdAt).
type fakeReindexRepo struct {
	// tickets sorted newest-first (set once at construction; never mutated).
	tickets []*repository.Ticket
}

// FindAll honours After (compound cursor "<unixMilli>:<id>") and mirrors the REAL
// MongoTicketRepository.FindAll contract: limit <=0 or >100 silently becomes 20
// (NOT 100).  Callers must pass a value in [1, 100] to get the intended page size.
func (f *fakeReindexRepo) FindAll(_ context.Context, p repository.PaginationParams) ([]*repository.Ticket, error) {
	limit := p.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	start := 0
	if p.After != "" {
		ms, id, ok := repository.ParseCursor(p.After)
		if !ok {
			return nil, fmt.Errorf("fakeReindexRepo: invalid cursor %q", p.After)
		}
		// Skip until we find the ticket whose cursor was the last one seen.
		for i, t := range f.tickets {
			if t.CreatedAt.UnixMilli() == ms && t.ID == id {
				start = i + 1
				break
			}
		}
	}

	if start >= len(f.tickets) {
		return nil, nil
	}

	end := start + limit
	if end > len(f.tickets) {
		end = len(f.tickets)
	}
	return f.tickets[start:end], nil
}

// makeTickets creates n tickets with descending createdAt (index 0 = newest).
func makeTickets(n int) []*repository.Ticket {
	base := time.Now().UTC().Truncate(time.Millisecond)
	tickets := make([]*repository.Ticket, n)
	for i := 0; i < n; i++ {
		tickets[i] = &repository.Ticket{
			ID:        fmt.Sprintf("t%04d", i),
			Title:     fmt.Sprintf("Ticket %d", i),
			Price:     "10.00",
			UserID:    "u1",
			Category:  "CONCERT",
			Version:   1,
			CreatedAt: base.Add(-time.Duration(i) * time.Second),
		}
	}
	// Sort newest-first (index 0 = largest createdAt).
	sort.Slice(tickets, func(a, b int) bool {
		return tickets[a].CreatedAt.After(tickets[b].CreatedAt)
	})
	return tickets
}

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

// TestReindex_PopulatesIndexFromMongo verifies that Reindex pages all tickets
// through the cursor loop and lands every one in the index, regardless of the
// effective page size used by FindAll.
//
// WHY pageSize=500 is used deliberately:
//   - The fake FindAll mirrors the real MongoTicketRepository: limit >100 silently
//     becomes 20.  So 150 tickets take 8 pages of 20 (last page has 10).
//   - The loop must exit only on an empty page, not when len(page) < pageSize.
//   - The assertion countDocs==150 therefore catches any early-exit regression.
func TestReindex_PopulatesIndexFromMongo(t *testing.T) {
	ctx := context.Background()
	url := requireSearchTestURL(t)

	const idx = "tickets_reindex_test"
	deleteTestIndex(t, url, idx)
	t.Cleanup(func() { deleteTestIndex(t, url, idx) })

	c, err := search.NewClient(url, idx, zap.NewNop())
	require.NoError(t, err)
	require.NoError(t, c.EnsureIndex(ctx))

	const total = 150
	repo := &fakeReindexRepo{tickets: makeTickets(total)}

	// pageSize=500 is out-of-range: the fake (mirroring real FindAll) falls back to 20
	// docs/page.  The cursor loop must still exhaust all pages and index every ticket.
	require.NoError(t, search.Reindex(ctx, repo, c, 500, nil))
	require.Equal(t, int64(total), countDocs(t, url, idx),
		"expected all %d tickets to be indexed regardless of page size", total)
}
