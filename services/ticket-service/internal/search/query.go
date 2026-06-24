package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
)

// Result pairs a hydrated Ticket with the opaque cursor for this position in the
// OpenSearch result set.  Cursor is of the form "os:<score>:<id>".
type Result struct {
	Ticket *repository.Ticket
	Cursor string
}

// Hit is a single ranked result from a Query call.
type Hit struct {
	ID   string
	Sort []any // raw sort tuple returned by OpenSearch (used as search_after on the next page)
}

// QueryParams controls what the query matches and how it is paginated.
type QueryParams struct {
	Search   string
	Category string
	MinPrice *float64
	MaxPrice *float64
	Limit    int
	After    string // "os:<score>:<id>" cursor; empty = first page
}

// Query executes a best_fields multi_match search against the index and returns
// the ranked hits (IDs + sort tuples) for the caller to hydrate via FindByIDs.
func (c *Client) Query(ctx context.Context, p QueryParams) ([]Hit, error) {
	limit := p.Limit
	if limit <= 0 {
		limit = 20
	}

	// --- bool query ---------------------------------------------------------

	multiMatch := map[string]any{
		"multi_match": map[string]any{
			"query":         p.Search,
			"type":          "best_fields",
			"fields":        []string{"eventTitle^3", "title^2", "venueName^2", "description", "venueAddress"},
			"fuzziness":     "AUTO",
			"prefix_length": 1,
		},
	}

	var filters []map[string]any
	if p.Category != "" {
		filters = append(filters, map[string]any{
			"term": map[string]any{"category": p.Category},
		})
	}
	rangeFilter := map[string]any{}
	if p.MinPrice != nil {
		rangeFilter["gte"] = *p.MinPrice
	}
	if p.MaxPrice != nil {
		rangeFilter["lte"] = *p.MaxPrice
	}
	if len(rangeFilter) > 0 {
		filters = append(filters, map[string]any{
			"range": map[string]any{"price": rangeFilter},
		})
	}

	boolQ := map[string]any{"must": multiMatch}
	if len(filters) > 0 {
		boolQ["filter"] = filters
	}

	body := map[string]any{
		"size":  limit,
		"query": map[string]any{"bool": boolQ},
		"sort": []map[string]any{
			{"_score": map[string]any{"order": "desc"}},
			{"_id": map[string]any{"order": "asc"}},
		},
	}

	// Apply search_after from an "os:<score>:<id>" cursor.
	if p.After != "" && strings.HasPrefix(p.After, "os:") {
		rest := strings.TrimPrefix(p.After, "os:")
		colonIdx := strings.IndexByte(rest, ':')
		if colonIdx > 0 {
			scoreStr := rest[:colonIdx]
			afterID := rest[colonIdx+1:]
			if score, err := strconv.ParseFloat(scoreStr, 64); err == nil && !math.IsNaN(score) && !math.IsInf(score, 0) && afterID != "" {
				body["search_after"] = []any{score, afterID}
			}
		}
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("search.Query: marshal body: %w", err)
	}

	callCtx, cancel := context.WithTimeout(ctx, opensearchQueryTimeout)
	defer cancel()

	hits, err := c.breaker.Execute(func() ([]Hit, error) {
		resp, searchErr := c.api.Search(callCtx, &opensearchapi.SearchReq{
			Indices: []string{c.index},
			Body:    bytes.NewReader(bodyBytes),
		})
		if searchErr != nil {
			return nil, searchErr
		}
		result := make([]Hit, len(resp.Hits.Hits))
		for i, h := range resp.Hits.Hits {
			result[i] = Hit{ID: h.ID, Sort: h.Sort}
		}
		return result, nil
	})
	if err != nil {
		return nil, fmt.Errorf("search.Query: %w", err)
	}
	return hits, nil
}
