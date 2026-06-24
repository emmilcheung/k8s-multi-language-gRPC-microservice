package search

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// newTestClient creates a search.Client pointing at the given httptest server URL.
// The index name is fixed to "test-idx".
func newTestClient(t *testing.T, serverURL string) *Client {
	t.Helper()
	c, err := NewClient(serverURL, "test-idx", zap.NewNop())
	require.NoError(t, err)
	return c
}

// osSearchResponse builds a minimal OpenSearch search response JSON with the
// given hit IDs and sort tuples (score, id).
func osSearchResponse(hits []struct {
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

	r := resp{Hits: hitsWrapper{}}
	for _, h := range hits {
		r.Hits.Hits = append(r.Hits.Hits, hitDoc{ID: h.id, Sort: []any{h.score, h.id}})
	}
	b, _ := json.Marshal(r)
	return b
}

// TestQuery_DefaultLimit verifies that a zero/negative Limit is clamped to 20.
func TestQuery_DefaultLimit(t *testing.T) {
	var capturedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "_search") {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			b, _ := json.Marshal(body)
			capturedBody = string(b)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(osSearchResponse(nil))
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv.URL)
	hits, err := c.Query(t.Context(), QueryParams{Search: "concert", Limit: 0})
	require.NoError(t, err)
	assert.Empty(t, hits)

	var parsed map[string]any
	require.NoError(t, json.Unmarshal([]byte(capturedBody), &parsed))
	assert.Equal(t, float64(20), parsed["size"], "Limit=0 must default to 20")
}

// TestQuery_CategoryAndPriceFilters verifies that category and price range are
// included in the OpenSearch bool filter when provided.
func TestQuery_CategoryAndPriceFilters(t *testing.T) {
	var capturedBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "_search") {
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(osSearchResponse(nil))
		} else {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv.URL)
	minP := 10.0
	maxP := 100.0
	_, err := c.Query(t.Context(), QueryParams{
		Search:   "show",
		Category: "CONCERT",
		MinPrice: &minP,
		MaxPrice: &maxP,
		Limit:    5,
	})
	require.NoError(t, err)
	require.NotNil(t, capturedBody)

	query := capturedBody["query"].(map[string]any)
	boolQ := query["bool"].(map[string]any)
	filters := boolQ["filter"].([]any)
	require.Len(t, filters, 2, "expected category + price filters")

	// category term filter
	termFilter := filters[0].(map[string]any)["term"].(map[string]any)
	assert.Equal(t, "CONCERT", termFilter["category"])

	// price range filter
	priceFilter := filters[1].(map[string]any)["range"].(map[string]any)["price"].(map[string]any)
	assert.Equal(t, float64(10), priceFilter["gte"])
	assert.Equal(t, float64(100), priceFilter["lte"])
}

// TestQuery_CursorParsing exercises the search_after cursor logic.
func TestQuery_CursorParsing(t *testing.T) {
	tests := []struct {
		name           string
		after          string
		wantSearchAfter bool
	}{
		{
			name:           "empty after — no search_after in body",
			after:          "",
			wantSearchAfter: false,
		},
		{
			name:           "valid os cursor — search_after injected",
			after:          "os:1.5:ticket-id-123",
			wantSearchAfter: true,
		},
		{
			name:           "non-numeric score — search_after omitted",
			after:          "os:NaN:ticket-id-123",
			wantSearchAfter: false,
		},
		{
			name:           "malformed prefix — search_after omitted",
			after:          "mongo:somecursor",
			wantSearchAfter: false,
		},
		{
			name:           "os: prefix with no colon after score — search_after omitted",
			after:          "os:1.5",
			wantSearchAfter: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var capturedBody map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "_search") {
					_ = json.NewDecoder(r.Body).Decode(&capturedBody)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(osSearchResponse(nil))
				} else {
					w.WriteHeader(http.StatusOK)
				}
			}))
			defer srv.Close()

			c := newTestClient(t, srv.URL)
			_, err := c.Query(t.Context(), QueryParams{Search: "test", Limit: 5, After: tc.after})
			require.NoError(t, err)

			_, hasSearchAfter := capturedBody["search_after"]
			assert.Equal(t, tc.wantSearchAfter, hasSearchAfter,
				"search_after presence mismatch for cursor %q", tc.after)
		})
	}
}
