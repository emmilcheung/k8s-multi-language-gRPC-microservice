//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/acme/ticket-service/internal/search"
	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// getDoc fetches a document by ID from the given index and returns the _source map.
func getDoc(t *testing.T, url, index, id string) map[string]any {
	t.Helper()

	api, err := opensearchapi.NewClient(opensearchapi.Config{
		Client: opensearch.Config{Addresses: []string{url}},
	})
	require.NoError(t, err)

	resp, err := api.Document.Get(context.Background(), opensearchapi.DocumentGetReq{
		Index:      index,
		DocumentID: id,
	})
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.Inspect().Response.StatusCode)

	var source map[string]any
	require.NoError(t, json.Unmarshal(resp.Source, &source))
	return source
}

func TestIndexer_ExternalVersion_IgnoresStaleUpdate(t *testing.T) {
	ctx := context.Background()
	url := requireOpenSearchURL(t)

	const idx = "tickets_indexer_test"
	deleteTestIndex(t, url, idx)
	t.Cleanup(func() { deleteTestIndex(t, url, idx) })

	c, err := search.NewClient(url, idx, zap.NewNop())
	require.NoError(t, err)
	require.NoError(t, c.EnsureIndex(ctx))

	// Write version 2 first.
	require.NoError(t, c.UpsertTicket(ctx, search.Doc{
		ID:         "tk1",
		EventTitle: "Eras Tour v2",
		Version:    2,
		CreatedAt:  "2026-06-01T12:00:00Z",
	}))

	// Stale lower-version update must NOT overwrite — should return nil.
	err = c.UpsertTicket(ctx, search.Doc{
		ID:         "tk1",
		EventTitle: "Eras Tour v1",
		Version:    1,
		CreatedAt:  "2026-06-01T12:00:00Z",
	})
	require.NoError(t, err, "external-version conflict must be swallowed as success")

	// Document should still reflect the version-2 write.
	doc := getDoc(t, url, idx, "tk1")
	require.Equal(t, "Eras Tour v2", doc["eventTitle"])
	require.NotEmpty(t, doc["createdAt"], "regression guard: createdAt must not be zero/empty")
}
