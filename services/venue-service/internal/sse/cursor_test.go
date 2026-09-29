package sse_test

import (
	"strings"
	"testing"

	"github.com/acme/venue-service/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// A seat-change frame has to carry its version as the SSE event id, because the
// id is the only thing a browser EventSource replays on reconnect. Without it a
// reconnecting client cannot tell a new pod what it already has, and the pod
// cannot tell whether the client needs to resync.

func TestFormatChange_CarriesTheVersionAsTheEventID(t *testing.T) {
	frame := sse.FormatChange([]byte(`{"event":"held","seatIds":["a"],"v":7}`))

	assert.True(t, strings.HasPrefix(frame, "id: 7\n"),
		"the version must be the event id, got: %q", frame)
	assert.Contains(t, frame, `"seatIds":["a"]`, "the payload must survive intact")
	assert.True(t, strings.HasSuffix(frame, "\n\n"), "an SSE frame ends with a blank line")
}

func TestFormatChange_OmitsTheIDWhenThereIsNoVersion(t *testing.T) {
	// The manager publishes v:0 when Redis refused to allocate a version. An
	// `id: 0` would be worse than no id: the client would store it and replay
	// it as a cursor that means nothing.
	for _, payload := range []string{
		`{"event":"held","v":0}`,
		`{"event":"held"}`,
		`not json at all`,
	} {
		frame := sse.FormatChange([]byte(payload))
		assert.False(t, strings.Contains(frame, "id:"),
			"unversioned payload %q must not get an id, got: %q", payload, frame)
		assert.True(t, strings.HasPrefix(frame, "data: "))
	}
}

func TestPublish_FlagsAClientThatMissedAMessage(t *testing.T) {
	b := sse.NewBroadcaster(nil, zap.NewNop())
	c := b.Subscribe("plan-1")
	defer b.Unsubscribe(c)

	require.False(t, c.Gapped(), "a fresh client has missed nothing")

	// Fill the 64-message buffer, then overflow it. Before this flag existed the
	// overflow was silent: the client went on applying later deltas to a seat
	// map that had already diverged, and showed seats as free that were held.
	for range 64 {
		b.Publish("plan-1", "data: x\n\n")
	}
	require.False(t, c.Gapped(), "a full buffer is not yet a gap — nothing was dropped")

	b.Publish("plan-1", "data: dropped\n\n")

	assert.True(t, c.Gapped(), "a dropped message must be recorded as a gap")
	assert.False(t, c.Gapped(), "reading the gap clears it, so one gap means one resync")
}
