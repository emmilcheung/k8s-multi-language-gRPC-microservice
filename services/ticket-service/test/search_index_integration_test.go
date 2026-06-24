//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/acme/ticket-service/internal/search"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

const testIndex = "tickets_test"

// requireOpenSearchURL returns the OpenSearch URL to use for integration
// tests. It does NOT spin up a container — if OPENSEARCH_TEST_URL is set it
// uses that; otherwise it skips the test with an instructive message.
func requireOpenSearchURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("OPENSEARCH_TEST_URL")
	if url == "" {
		t.Skip("set OPENSEARCH_TEST_URL to run OpenSearch integration tests (e.g. OPENSEARCH_TEST_URL=http://localhost:9200)")
	}
	return url
}

// getMappingProperties fetches the property map for the given index by calling
// GET /<index>/_mapping and navigating the returned JSON.
func getMappingProperties(t *testing.T, url, index string) map[string]any {
	t.Helper()

	api, err := opensearchapi.NewClient(opensearchapi.Config{
		Client: opensearch.Config{Addresses: []string{url}},
	})
	require.NoError(t, err)

	resp, err := api.Indices.Mapping.Get(context.Background(), &opensearchapi.MappingGetReq{
		Indices: []string{index},
	})
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.Inspect().Response.StatusCode)

	raw, ok := resp.Indices[index]
	require.True(t, ok, "index %q not found in mapping response", index)

	// raw.Mappings is the full mappings object, e.g. {"properties": {...}}
	var mappings struct {
		Properties map[string]any `json:"properties"`
	}
	require.NoError(t, json.Unmarshal(raw.Mappings, &mappings))
	return mappings.Properties
}

func TestEnsureIndex_CreatesMappingIdempotently(t *testing.T) {
	ctx := context.Background()
	url := requireOpenSearchURL(t)

	// Ensure the test index does not exist before the test and is cleaned up after.
	deleteTestIndex(t, url, testIndex)
	t.Cleanup(func() { deleteTestIndex(t, url, testIndex) })

	c, err := search.NewClient(url, testIndex, zap.NewNop())
	require.NoError(t, err)

	// First call — should create the index.
	require.NoError(t, c.EnsureIndex(ctx))

	// Second call — must be idempotent (no error on existing index).
	require.NoError(t, c.EnsureIndex(ctx))

	// Verify the mapping was applied correctly.
	props := getMappingProperties(t, url, testIndex)
	require.Equal(t, "text", props["eventTitle"].(map[string]any)["type"])
	require.Equal(t, "keyword", props["category"].(map[string]any)["type"])
	require.Equal(t, "date", props["createdAt"].(map[string]any)["type"])
	// price uses scaled_float with scaling_factor=100 — the most unusual spec requirement.
	priceProps := props["price"].(map[string]any)
	require.Equal(t, "scaled_float", priceProps["type"])
	require.Equal(t, float64(100), priceProps["scaling_factor"])
	// ticketType must be keyword for exact-match filtering.
	require.Equal(t, "keyword", props["ticketType"].(map[string]any)["type"])
}

// deleteTestIndex deletes the index if it exists; ignores 404.
func deleteTestIndex(t *testing.T, url, index string) {
	t.Helper()

	api, err := opensearchapi.NewClient(opensearchapi.Config{
		Client: opensearch.Config{Addresses: []string{url}},
	})
	require.NoError(t, err)

	_, err = api.Indices.Delete(context.Background(), opensearchapi.IndicesDeleteReq{
		Indices: []string{index},
	})
	if err != nil {
		// 404 means it didn't exist — that's fine.
		t.Logf("deleteTestIndex(%s): %v (ignored)", index, err)
	}
}
