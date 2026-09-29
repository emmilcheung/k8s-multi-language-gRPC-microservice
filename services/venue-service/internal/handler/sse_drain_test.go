package handler_test

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/sse"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// These tests cover what a pod does to its live SSE streams when it is told to
// go away — during a scale-in, a rolling deploy or a node drain. The behaviour
// that matters is not "the handler returns"; it is that the client is told when
// to come back, and that a client arriving mid-shutdown is not given a stream
// about to be closed.

// drainableBroadcaster is the real Broadcaster behind the handler's narrow
// interface. Using the real one keeps the test honest about Drain's semantics
// rather than restating them in a stub.
func newSSETestHandler() (*handler.SSEHandler, *sse.Broadcaster) {
	b := sse.NewBroadcaster(nil, zap.NewNop())
	return handler.NewSSEHandler(b, zap.NewNop()), b
}

func sseRequest(t *testing.T, h *handler.SSEHandler, planID string) (*httptest.ResponseRecorder, echo.Context) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/seating-plans/"+planID+"/events", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues(planID)
	return rec, c
}

func TestSSEStream_RefusesNewStreamsWhileDraining(t *testing.T) {
	h, b := newSSETestHandler()
	b.Drain()

	rec, c := sseRequest(t, h, "plan-1")
	require.NoError(t, h.Stream(c))

	// A client that connects between SIGTERM and the endpoint removal reaching
	// kube-proxy must be sent away immediately. Handing it a stream would cost
	// it a second reconnect for no benefit.
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("Retry-After"),
		"the client needs to know it may retry straight away — another pod will serve it")
	assert.NotContains(t, rec.Header().Get("Content-Type"), "text/event-stream",
		"a refusal must not masquerade as a stream")
}

func TestSSEStream_ReleasesLiveStreamWithAReconnectDelay(t *testing.T) {
	h, b := newSSETestHandler()

	rec, c := sseRequest(t, h, "plan-1")

	done := make(chan error, 1)
	go func() { done <- h.Stream(c) }()

	// Let the handler get as far as subscribing and writing its preamble.
	time.Sleep(50 * time.Millisecond)
	b.Drain()

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("Drain must end the stream; a stream that ignores it is exactly " +
			"what makes graceful shutdown hang until its timeout")
	}

	body := rec.Body.String()
	assert.Contains(t, body, ": connected", "the stream should have started normally")

	// The retry field is the whole point: it is how the server tells an SSE
	// client when to reconnect. Without it every released client uses the
	// browser default and they all return together, to fewer pods than before.
	m := regexp.MustCompile(`retry: (\d+)`).FindStringSubmatch(body)
	require.Len(t, m, 2, "a released stream must carry a retry field, got: %q", body)

	delay, err := strconv.Atoi(m[1])
	require.NoError(t, err)
	assert.GreaterOrEqual(t, delay, 500)
	assert.Less(t, delay, 5000)
}

func TestSSEStream_ReconnectDelaysAreSpreadAcrossClients(t *testing.T) {
	// One pod can hold thousands of streams. If they all reconnect at the same
	// moment they arrive at the surviving pods as a spike, at the point when
	// there is less capacity than before. The delays must actually differ.
	const streams = 25

	h, b := newSSETestHandler()
	recs := make([]*httptest.ResponseRecorder, streams)
	done := make(chan error, streams)

	for i := range streams {
		rec, c := sseRequest(t, h, "plan-1")
		recs[i] = rec
		go func() { done <- h.Stream(c) }()
	}

	time.Sleep(100 * time.Millisecond)
	b.Drain()

	for range streams {
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(2 * time.Second):
			t.Fatal("every stream must be released by Drain")
		}
	}

	re := regexp.MustCompile(`retry: (\d+)`)
	seen := map[string]struct{}{}
	for _, rec := range recs {
		m := re.FindStringSubmatch(rec.Body.String())
		require.Len(t, m, 2)
		seen[m[1]] = struct{}{}
	}

	// Jitter is random, so this asserts the property (spread) rather than an
	// exact count. Identical delays across 25 streams would mean the jitter is
	// gone — which is the regression worth catching.
	assert.Greater(t, len(seen), streams/2,
		"reconnect delays should be spread across clients, saw %d distinct values", len(seen))
}
