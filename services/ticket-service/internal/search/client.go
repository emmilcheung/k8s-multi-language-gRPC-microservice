package search

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/opensearch-project/opensearch-go/v4"
	"github.com/opensearch-project/opensearch-go/v4/opensearchapi"
	"github.com/sony/gobreaker/v2"
	"go.uber.org/zap"
)

// Doc is the slim index document written to OpenSearch.
// ID and Version are used as the document _id and external version for idempotent upserts;
// they are NOT serialized into the document body (omitempty + "-" would be ideal but
// the SDK serialises from the struct, so we strip them in UpsertTicket).
type Doc struct {
	ID            string  `json:"-"`
	Version       int     `json:"-"`
	EventTitle    string  `json:"eventTitle"`
	Title         string  `json:"title"`
	VenueName     string  `json:"venueName"`
	Description   string  `json:"description"`
	VenueAddress  string  `json:"venueAddress"`
	Category      string  `json:"category"`
	TicketType    string  `json:"ticketType"`
	SeatingPlanID string  `json:"seatingPlanId"`
	Price         float64 `json:"price"`
	StartsAt      string  `json:"startsAt,omitempty"`
	CreatedAt     string  `json:"createdAt,omitempty"`
}

const opensearchHTTPTimeout = 10 * time.Second

// opensearchQueryTimeout is the hard per-call deadline applied to Query (docs/09: 10s outbound).
const opensearchQueryTimeout = 10 * time.Second

// Client wraps the OpenSearch API client and holds the target index name.
type Client struct {
	api     *opensearchapi.Client
	breaker *gobreaker.CircuitBreaker[[]Hit]
	index   string
	log     *zap.Logger
}

// NewClient creates an OpenSearch client for plain HTTP with no auth.
// A 10-second timeout is enforced at the transport layer (docs/09 requirement).
func NewClient(url, index string, log *zap.Logger) (*Client, error) {
	api, err := opensearchapi.NewClient(opensearchapi.Config{
		Client: opensearch.Config{
			Addresses: []string{url},
			Transport: &http.Transport{
				// Wrap inside an http.Transport so we can set ResponseHeaderTimeout.
				// The per-request deadline is enforced via the context passed to each
				// API call, but the transport-level timeout prevents hung connections
				// when no context deadline is set (e.g. EnsureIndex at startup).
				ResponseHeaderTimeout: opensearchHTTPTimeout,
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("search.NewClient: %w", err)
	}

	settings := gobreaker.Settings{
		Name:        "opensearch",
		Interval:    30 * time.Second,
		Timeout:     15 * time.Second,
		MaxRequests: 1,
		IsSuccessful: func(err error) bool {
			return !shouldCountOpenSearchFailure(err)
		},
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			if counts.Requests < 10 {
				return false
			}
			return float64(counts.TotalFailures)/float64(counts.Requests) >= 0.5
		},
		OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
			log.Warn("opensearch circuit breaker state changed",
				zap.String("dependency", name),
				zap.String("from", from.String()),
				zap.String("to", to.String()),
			)
		},
	}

	return &Client{
		api:     api,
		breaker: gobreaker.NewCircuitBreaker[[]Hit](settings),
		index:   index,
		log:     log,
	}, nil
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
	_, createErr := c.api.Indices.Create(ctx, opensearchapi.IndicesCreateReq{
		Index: c.index,
		Body:  body,
	})
	if createErr != nil {
		// Treat "already exists" as success (race with a concurrent bootstrap).
		// Only swallow if the error type is resource_already_exists_exception;
		// any other 400 (e.g. malformed mapping) must be returned as an error.
		var structErr *opensearch.StructError
		if errors.As(createErr, &structErr) && structErr.Err.Type == "resource_already_exists_exception" {
			c.log.Info("opensearch: index already exists (concurrent create)", zap.String("index", c.index))
			return nil
		}
		return fmt.Errorf("search.EnsureIndex create: %w", createErr)
	}

	c.log.Info("opensearch: index created", zap.String("index", c.index))
	return nil
}

// shouldCountOpenSearchFailure mirrors venue_client.go's shouldCountVenueServiceFailure:
// context.Canceled (user-aborted request) must not count as a breaker failure.
func shouldCountOpenSearchFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	return true
}

// Ping checks cluster reachability via a HEAD / request.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.api.Ping(ctx, nil)
	if err != nil {
		return fmt.Errorf("search.Ping: %w", err)
	}
	return nil
}

// UpsertTicket writes d to the index using PUT /<index>/_doc/<id>?version=<Version>&version_type=external.
// A version conflict (409 / version_conflict_engine_exception) is treated as success — a stale
// event that arrived out of order must never overwrite a newer document.
func (c *Client) UpsertTicket(ctx context.Context, d Doc) error {
	body, err := json.Marshal(d)
	if err != nil {
		return fmt.Errorf("search.UpsertTicket: marshal doc: %w", err)
	}

	// Apply the same per-call deadline as Query (docs/09: 10 s outbound timeout).
	// Both the Indexer and reindex call sites inherit this from here.
	callCtx, cancel := context.WithTimeout(ctx, opensearchQueryTimeout)
	defer cancel()

	version := d.Version
	_, err = c.api.Index(callCtx, opensearchapi.IndexReq{
		Index:      c.index,
		DocumentID: d.ID,
		Body:       bytes.NewReader(body),
		Params: opensearchapi.IndexParams{
			Version:     &version,
			VersionType: "external",
		},
	})
	if err != nil {
		var structErr *opensearch.StructError
		if errors.As(err, &structErr) && structErr.Err.Type == "version_conflict_engine_exception" {
			c.log.Debug("search.UpsertTicket: stale version ignored",
				zap.String("id", d.ID),
				zap.Int("version", d.Version),
			)
			return nil
		}
		return fmt.Errorf("search.UpsertTicket: %w", err)
	}
	return nil
}
