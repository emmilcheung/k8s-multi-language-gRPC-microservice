package sse_test

import (
	"testing"

	"github.com/acme/venue-service/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// Why these tests exist: an SSE stream never completes on its own, so a
// graceful HTTP shutdown has nothing to wait for and cuts every connection when
// its timeout expires. Drain is the signal that lets each stream end itself
// first. If these assertions stop holding, pods drop live seat-availability
// streams on every scale-in and deploy.

func TestDrain_SignalsEveryWaiter(t *testing.T) {
	b := sse.NewBroadcaster(nil, zap.NewNop())

	require.False(t, b.IsDraining(), "a fresh broadcaster must not be draining")

	select {
	case <-b.Draining():
		t.Fatal("Draining() closed before Drain() was called")
	default:
	}

	b.Drain()

	assert.True(t, b.IsDraining())
	select {
	case <-b.Draining():
	default:
		t.Fatal("Draining() must be closed once Drain() has been called")
	}
}

func TestDrain_IsIdempotent(t *testing.T) {
	b := sse.NewBroadcaster(nil, zap.NewNop())

	// Shutdown paths are easy to trigger twice — a signal handler and a failing
	// errgroup can both reach it. Closing an already-closed channel panics, so
	// this is the assertion that keeps a second call from taking the process
	// down during the shutdown it was supposed to make graceful.
	assert.NotPanics(t, func() {
		b.Drain()
		b.Drain()
		b.Drain()
	})

	assert.True(t, b.IsDraining())
}

func TestDrain_DoesNotDisturbDelivery(t *testing.T) {
	b := sse.NewBroadcaster(nil, zap.NewNop())

	c := b.Subscribe("plan-1")
	defer b.Unsubscribe(c)

	// Draining releases streams; it is the handler's job to stop reading, not
	// the broadcaster's job to stop publishing. A message already queued must
	// still be deliverable, otherwise a seat change made during shutdown is
	// lost rather than merely re-sent after the client reconnects.
	b.Drain()
	b.Publish("plan-1", "data: still-delivered\n\n")

	select {
	case msg := <-c.MsgChan:
		assert.Equal(t, "data: still-delivered\n\n", msg)
	default:
		t.Fatal("publish after Drain must still reach a subscribed client")
	}
}
