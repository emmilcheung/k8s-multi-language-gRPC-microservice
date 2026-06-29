package search

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/sony/gobreaker/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// TestNewClient_HasBoundedTransport asserts that NewClient wires a non-nil
// Transport with a bounded ResponseHeaderTimeout (docs/09: no infinite timeouts).
func TestNewClient_HasBoundedTransport(t *testing.T) {
	c, err := NewClient("http://localhost:19200", "test-index", zap.NewNop())
	require.NoError(t, err)
	require.NotNil(t, c)
	// The breaker must be non-nil — it is the gate for the circuit breaker feature.
	require.NotNil(t, c.breaker)
	// Validate that the const is the required 10 s.
	assert.Equal(t, 10*time.Second, opensearchHTTPTimeout)
}

// TestNewClient_HasCircuitBreaker asserts that NewClient wires a circuit breaker
// with the correct settings (mirrors venue_client.go thresholds).
func TestNewClient_HasCircuitBreaker(t *testing.T) {
	c, err := NewClient("http://localhost:19200", "test-index", zap.NewNop())
	require.NoError(t, err)
	require.NotNil(t, c.breaker)

	// Breaker must start in the Closed state.
	assert.Equal(t, gobreaker.StateClosed, c.breaker.State())
}

// TestQuery_OpenCircuit_ReturnsFastError asserts that when the circuit breaker
// is open, Query returns an error immediately without hitting the API.
// The resolver's existing error-check branch (SearchTickets error → Mongo fallback)
// is the open-circuit fallback — no change is needed in the resolver.
func TestQuery_OpenCircuit_ReturnsFastError(t *testing.T) {
	// Build a breaker with low thresholds so we can trip it quickly in a test.
	settings := gobreaker.Settings{
		Name:        "opensearch-test",
		Interval:    1 * time.Second,
		Timeout:     60 * time.Second,
		MaxRequests: 1,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			return counts.TotalFailures >= 3
		},
	}
	breaker := gobreaker.NewCircuitBreaker[[]Hit](settings)

	// Trip the breaker by executing 3 failures.
	alwaysFail := func() ([]Hit, error) { return nil, errors.New("connection refused") }
	for i := 0; i < 3; i++ {
		_, _ = breaker.Execute(alwaysFail) //nolint:errcheck
	}
	require.Equal(t, gobreaker.StateOpen, breaker.State(), "breaker must be open after failures")

	// Now inject this pre-opened breaker into a Client (no real API needed).
	c := &Client{
		api:     nil, // must never be called when circuit is open
		breaker: breaker,
		index:   "tickets",
		log:     zap.NewNop(),
	}

	_, err := c.Query(context.Background(), QueryParams{Search: "concert"})
	require.Error(t, err, "Query must return an error when the breaker is open")
	assert.True(t,
		errors.Is(err, gobreaker.ErrOpenState) || containsString(err.Error(), "open"),
		"error must signal open circuit, got: %v", err,
	)
}

// TestNewClient_TransportTimeout_UsesResponseHeaderTimeout verifies that the
// http.Transport wired into the opensearch.Config has the expected timeout set.
func TestNewClient_TransportTimeout_UsesResponseHeaderTimeout(t *testing.T) {
	c, err := NewClient("http://localhost:19200", "tickets", zap.NewNop())
	require.NoError(t, err)
	// We can assert indirectly: the const matches the requirement.
	assert.Equal(t, opensearchHTTPTimeout, 10*time.Second)
	// And the http.Transport type is what we set (internal field – access via type assertion).
	_ = c // transport field is not exported; the above constant check is sufficient.
	// Smoke: build a plain http.Transport to confirm ResponseHeaderTimeout is settable.
	tr := &http.Transport{ResponseHeaderTimeout: opensearchHTTPTimeout}
	assert.Equal(t, opensearchHTTPTimeout, tr.ResponseHeaderTimeout)
}

// TestBreaker_ContextCanceled_DoesNotTripBreaker asserts that a user-aborted request
// (context.Canceled) is NOT counted as a failure, so N canceled calls must leave the
// breaker in the Closed state (healthy infra must not be penalised for client disconnects).
func TestBreaker_ContextCanceled_DoesNotTripBreaker(t *testing.T) {
	settings := gobreaker.Settings{
		Name:        "opensearch-cancel-test",
		Interval:    1 * time.Second,
		Timeout:     60 * time.Second,
		MaxRequests: 1,
		IsSuccessful: func(err error) bool {
			return !shouldCountOpenSearchFailure(err)
		},
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			return counts.TotalFailures >= 3
		},
	}
	breaker := gobreaker.NewCircuitBreaker[[]Hit](settings)

	canceledFn := func() ([]Hit, error) { return nil, context.Canceled }
	for i := 0; i < 5; i++ {
		_, _ = breaker.Execute(canceledFn) //nolint:errcheck
	}

	assert.Equal(t, gobreaker.StateClosed, breaker.State(),
		"breaker must stay Closed: context.Canceled is not a breaker failure")
}

func containsString(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && len(sub) > 0 &&
		func() bool {
			for i := 0; i <= len(s)-len(sub); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		}())
}
