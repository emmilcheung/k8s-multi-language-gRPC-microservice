package handler_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/sse"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// Nothing replays SSE events here — there is no event log. So any client that
// has missed something must be told to re-read the availability snapshot, whose
// response carries the version to resume from. These tests cover the two ways a
// client can miss something: it reconnected onto a different pod, or its buffer
// overflowed.

func sseRequestWithCursor(t *testing.T, planID, cursor string) (*httptest.ResponseRecorder, echo.Context) {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/seating-plans/"+planID+"/events", nil)
	if cursor != "" {
		req.Header.Set("Last-Event-ID", cursor)
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues(planID)
	return rec, c
}

func TestSSEStream_AsksAReconnectingClientToResync(t *testing.T) {
	h, b := newSSETestHandler()

	rec, c := sseRequestWithCursor(t, "plan-1", "42")
	done := make(chan error, 1)
	go func() { done <- h.Stream(c) }()

	time.Sleep(50 * time.Millisecond)
	b.Drain()
	require.NoError(t, <-done)

	// The cursor says the client had state up to version 42. This pod has no
	// way to send it 43 onwards, so letting it carry on would leave it applying
	// deltas to a seat map with a hole in it.
	assert.Contains(t, rec.Body.String(), "event: resync")
	assert.Contains(t, rec.Body.String(), `"reason":"reconnect"`)
}

func TestSSEStream_DoesNotAskAFirstTimeClientToResync(t *testing.T) {
	h, b := newSSETestHandler()

	rec, c := sseRequestWithCursor(t, "plan-1", "")
	done := make(chan error, 1)
	go func() { done <- h.Stream(c) }()

	time.Sleep(50 * time.Millisecond)
	b.Drain()
	require.NoError(t, <-done)

	// A client with no cursor is about to fetch the snapshot anyway. Telling it
	// to resync would cost every new viewer of an on-sale page an extra
	// availability read, which is the read this whole path exists to avoid.
	assert.NotContains(t, rec.Body.String(), "event: resync")
}

// gappedPublisher hands the handler a client that has already missed a
// message. Racing the handler's own reader to overflow its buffer is not
// reproducible — the recorder drains faster than a test can fill — so the gap
// is created directly, which is what the broadcaster's own test covers.
type gappedPublisher struct {
	b      *sse.Broadcaster
	client *sse.Client
}

func (p *gappedPublisher) Subscribe(string) *sse.Client { return p.client }
func (p *gappedPublisher) Unsubscribe(*sse.Client)      {}
func (p *gappedPublisher) Draining() <-chan struct{}    { return p.b.Draining() }
func (p *gappedPublisher) IsDraining() bool             { return p.b.IsDraining() }

func TestSSEStream_AsksAGappedClientToResyncBeforeTheNextDelta(t *testing.T) {
	b := sse.NewBroadcaster(nil, zap.NewNop())
	client := b.Subscribe("plan-1")

	// Nothing is reading this client, so filling the 64-message buffer and then
	// publishing once more drops that message and flags the gap.
	for range 65 {
		b.Publish("plan-1", sse.FormatChange([]byte(`{"event":"held","v":1}`)))
	}

	h := handler.NewSSEHandler(&gappedPublisher{b: b, client: client}, zap.NewNop())
	rec, c := sseRequestWithCursor(t, "plan-1", "")

	done := make(chan error, 1)
	go func() { done <- h.Stream(c) }()

	time.Sleep(100 * time.Millisecond)
	b.Drain()
	require.NoError(t, <-done)

	body := rec.Body.String()
	require.Contains(t, body, "event: resync",
		"an overflowed buffer must produce a resync, not a silent hole")
	assert.Contains(t, body, `"reason":"buffer-overflow"`)

	// Ordering is the point: the resync has to arrive before the delta that
	// follows the gap, or the client applies that delta to state it has already
	// been told to throw away.
	resyncAt := indexOf(body, "event: resync")
	require.Greater(t, resyncAt, 0)
	assert.Contains(t, body[resyncAt:], "data: {",
		"a delta should follow the resync frame")
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
