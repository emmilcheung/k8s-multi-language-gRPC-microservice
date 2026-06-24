package search

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
	"go.uber.org/zap"
)

// Doc is the slim index document written to OpenSearch.
// Fields are populated by Task 4 (search write path).
type Doc struct {
	EventTitle    string  `json:"eventTitle"`
	Title         string  `json:"title"`
	VenueName     string  `json:"venueName"`
	Description   string  `json:"description"`
	VenueAddress  string  `json:"venueAddress"`
	Category      string  `json:"category"`
	TicketType    string  `json:"ticketType"`
	SeatingPlanID string  `json:"seatingPlanId"`
	Price         float64 `json:"price"`
	StartsAt      string  `json:"startsAt"`
	CreatedAt     string  `json:"createdAt"`
}

// Client wraps the OpenSearch API client and holds the target index name.
type Client struct {
	api   *opensearchapi.Client
	index string
	log   *zap.Logger
}

// NewClient creates an OpenSearch client for plain HTTP with no auth.
func NewClient(url, index string, log *zap.Logger) (*Client, error) {
	api, err := opensearchapi.NewClient(opensearchapi.Config{
		Client: opensearch.Config{
			Addresses: []string{url},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("search.NewClient: %w", err)
	}
	return &Client{api: api, index: index, log: log}, nil
}

// EnsureIndex creates the tickets index with the defined mapping if it does not
// already exist. It is safe to call multiple times (idempotent).
func (c *Client) EnsureIndex(ctx context.Context) error {
	resp, err := c.api.Indices.Exists(ctx, opensearchapi.IndicesExistsReq{
		Indices: []string{c.index},
	})
	if err == nil {
		// 200 — index already exists, nothing to do.
		c.log.Info("opensearch: index already exists", zap.String("index", c.index))
		return nil
	}

	// Any error from Exists when dataPointer is nil comes as a string "status: [NNN ...]".
	// Treat 404 as "not found → create"; anything else is a real error.
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("search.EnsureIndex: checking index existence: %w", err)
	}

	// Index does not exist — create it.
	body := strings.NewReader(indexMapping)
	createResp, createErr := c.api.Indices.Create(ctx, opensearchapi.IndicesCreateReq{
		Index: c.index,
		Body:  body,
	})
	if createErr != nil {
		// Treat "already exists" as success (race with a concurrent bootstrap).
		if createResp != nil && createResp.Inspect().Response != nil &&
			createResp.Inspect().Response.StatusCode == http.StatusBadRequest {
			// resource_already_exists_exception returns 400
			c.log.Info("opensearch: index already exists (concurrent create)", zap.String("index", c.index))
			return nil
		}
		return fmt.Errorf("search.EnsureIndex: creating index %q: %w", c.index, createErr)
	}

	c.log.Info("opensearch: index created", zap.String("index", c.index))
	return nil
}

// Ping checks cluster reachability via a HEAD / request.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.api.Ping(ctx, nil)
	if err != nil {
		return fmt.Errorf("search.Ping: %w", err)
	}
	return nil
}
