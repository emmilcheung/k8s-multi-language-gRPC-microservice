package kafka

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type fakeReader struct {
	messages  []*confluent.Message
	pos       int
	committed int
}

func (f *fakeReader) ReadMessage(_ time.Duration) (*confluent.Message, error) {
	if f.pos >= len(f.messages) {
		// Signal end-of-messages as a timeout so the loop keeps running until
		// the context is cancelled.
		return nil, confluent.NewError(confluent.ErrTimedOut, "", false)
	}
	msg := f.messages[f.pos]
	f.pos++
	return msg, nil
}

func (f *fakeReader) CommitMessage(_ *confluent.Message) ([]confluent.TopicPartition, error) {
	f.committed++
	return nil, nil
}

type fakePublisher struct {
	err       error
	published int
}

func (p *fakePublisher) Publish(_ string, _, _ []byte) error {
	p.published++
	return p.err
}

type fakeHandler struct {
	err   error
	calls int
	// failFirst makes the handler fail the first N calls, then succeed.
	failFirst int
}

func (h *fakeHandler) OnOrderCompleted(_ context.Context, _ OrderCompletedData) error {
	h.calls++
	if h.failFirst > 0 && h.calls <= h.failFirst {
		return h.err
	}
	if h.failFirst == 0 {
		return h.err
	}
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// buildMessage wraps an OrderCompletedData in a CloudEvent envelope and
// returns a confluent.Message ready for the consumer loop.
func buildMessage(t *testing.T) *confluent.Message {
	t.Helper()
	data, err := json.Marshal(OrderCompletedData{
		OrderID:  "order-1",
		UserID:   "user-1",
		TicketID: "ticket-1",
	})
	require.NoError(t, err)
	envelope, err := json.Marshal(CloudEvent{
		SpecVersion:     "1.0",
		Type:            "orders.order.completed",
		Source:          "test",
		ID:              "test-id",
		Time:            time.Now(),
		DataContentType: "application/json",
		Data:            data,
	})
	require.NoError(t, err)
	topic := TopicOrderCompleted
	return &confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &topic},
		Value:          envelope,
	}
}

func newConsumer(t *testing.T, h OrderEventHandler, p dlqPublisher) *OrderConsumer {
	t.Helper()
	c, err := NewOrderConsumer(
		[]string{"localhost:9092"},
		"test-group",
		h,
		p,
		zap.NewNop(),
	)
	require.NoError(t, err)
	return c
}

// runLoop drives c.loop with a context that is cancelled after all messages
// have been read (detected by waiting until committed+skipped == messages).
func runLoopUntilDrained(consumer *OrderConsumer, reader *fakeReader, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// Run loop; it will exit when ctx is cancelled (after the timeout or when
	// we manually cancel).
	consumer.loop(ctx, reader)
}

// ---------------------------------------------------------------------------
// Issue 1a: no commit when DLQ publish fails
// ---------------------------------------------------------------------------

func TestLoop_NoDLQ_NoCommit_WhenDLQPublishFails(t *testing.T) {
	reader := &fakeReader{messages: []*confluent.Message{buildMessage(t)}}
	pub := &fakePublisher{err: errors.New("dlq broker unavailable")}
	h := &fakeHandler{err: errors.New("handler failure")} // always fails → triggers DLQ

	c := newConsumer(t, h, pub)

	// Give the loop enough time to process the one message, then cancel.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	c.loop(ctx, reader)

	assert.Equal(t, 1, pub.published, "expected exactly one DLQ publish attempt")
	assert.Equal(t, 0, reader.committed, "offset must NOT be committed when DLQ publish fails")
}

// ---------------------------------------------------------------------------
// Issue 1b: commit IS performed after successful processing
// ---------------------------------------------------------------------------

func TestLoop_CommitsOffset_AfterSuccessfulProcessing(t *testing.T) {
	reader := &fakeReader{messages: []*confluent.Message{buildMessage(t)}}
	pub := &fakePublisher{}
	h := &fakeHandler{} // err == nil → success on first call

	c := newConsumer(t, h, pub)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	c.loop(ctx, reader)

	assert.Equal(t, 0, pub.published, "DLQ must not be published on success")
	assert.Equal(t, 1, reader.committed, "offset must be committed after successful processing")
}

// ---------------------------------------------------------------------------
// Issue 1c: commit IS performed when processing fails but DLQ succeeds
// ---------------------------------------------------------------------------

func TestLoop_CommitsOffset_WhenProcessingFailsButDLQSucceeds(t *testing.T) {
	reader := &fakeReader{messages: []*confluent.Message{buildMessage(t)}}
	pub := &fakePublisher{} // DLQ publish succeeds
	h := &fakeHandler{err: errors.New("handler failure")}

	c := newConsumer(t, h, pub)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	c.loop(ctx, reader)

	assert.Equal(t, 1, pub.published, "DLQ must be published once")
	assert.Equal(t, 1, reader.committed, "offset must be committed after successful DLQ forward")
}

// ---------------------------------------------------------------------------
// Issue 1d: retry path — handler eventually succeeds, offset committed once
// ---------------------------------------------------------------------------

func TestProcessMessage_RetriesUntilSuccess(t *testing.T) {
	const failFirst = 2
	h := &fakeHandler{err: errors.New("transient"), failFirst: failFirst}
	pub := &fakePublisher{}
	c := newConsumer(t, h, pub)

	// Build the raw message directly to call processMessage.
	msg := buildMessage(t)
	err := c.processMessage(context.Background(), msg)

	require.NoError(t, err, "processMessage should succeed after retries")
	assert.Equal(t, failFirst+1, h.calls, "handler should be called failFirst+1 times total")
	assert.Equal(t, 0, pub.published, "DLQ must not be used when handler eventually succeeds")
}

// ---------------------------------------------------------------------------
// Issue 1e: context cancellation unblocks retry sleep
// ---------------------------------------------------------------------------

func TestProcessMessage_RespectsContextCancellation_DuringRetry(t *testing.T) {
	h := &fakeHandler{err: errors.New("always fails")}
	pub := &fakePublisher{}
	c := newConsumer(t, h, pub)

	msg := buildMessage(t)

	// Cancel very quickly — the test should not block for baseRetryDelay (500ms).
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := c.processMessage(ctx, msg)
	elapsed := time.Since(start)

	require.Error(t, err)
	assert.Less(t, elapsed, 300*time.Millisecond,
		"retry sleep must be interrupted by context cancellation; took %s", elapsed)
}
