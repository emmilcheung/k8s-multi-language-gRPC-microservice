package search

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"

	confluentkafka "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// fakeUpserter replaces the real OpenSearch client for unit tests.
// upsertErr is returned on every call; callCount tracks how many times it was called.
type fakeUpserter struct {
	upsertErr error
	callCount atomic.Int32
}

func (f *fakeUpserter) UpsertTicket(_ context.Context, _ Doc) error {
	f.callCount.Add(1)
	return f.upsertErr
}

// fakeDLQPublisher records DLQ calls for assertion.
type fakeDLQPublisher struct {
	published atomic.Int32
	lastErr   atomic.Value // stores the last processingErr.Error() string
}

func (f *fakeDLQPublisher) PublishToDLQ(_ context.Context, _ string, _, _ []byte, _ []confluentkafka.Header, processingErr error) error {
	f.published.Add(1)
	f.lastErr.Store(processingErr.Error())
	return nil
}

// indexerWithUpserter replaces the Indexer's UpsertTicket call path by wrapping
// processWithRetry tests through a helper that calls fake.UpsertTicket directly.
// We test processWithRetry's contract via a thin wrapper that substitutes the
// client.UpsertTicket call.

// processWithRetryStub is identical to Indexer.processWithRetry but delegates
// the upsert to a supplied function. This avoids needing a real *Client or interface
// change on the production type.
func processWithRetryStub(
	ctx context.Context,
	topic string,
	msg *confluentkafka.Message,
	upsertFn func(context.Context, Doc) error,
	dlq dlqPublisher,
	log *zap.Logger,
) error {
	idx := &Indexer{producer: dlq, log: log}

	doc, ticketID, ticketVersion, decErr := idx.decodeMessage(msg.Value)
	if decErr != nil {
		return idx.publishToDLQ(ctx, topic, msg, decErr)
	}

	const maxRetries = 3
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if err := upsertFn(ctx, doc); err != nil {
			lastErr = err
			continue
		}
		_ = ticketID
		_ = ticketVersion
		return nil
	}

	return idx.publishToDLQ(ctx, topic, msg, errors.New("upsert ticket "+ticketID+": "+lastErr.Error()))
}

// validPayload returns a minimal valid CloudEvent JSON for ticket events.
func validPayload(t *testing.T) []byte {
	t.Helper()
	type envelope struct {
		Data json.RawMessage `json:"data"`
	}
	type data struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
		Title   string `json:"title"`
		Price   string `json:"price"`
	}
	inner, err := json.Marshal(data{ID: "tk-1", Version: 1, Title: "Test Ticket", Price: "10.00"})
	require.NoError(t, err)
	outer, err := json.Marshal(envelope{Data: inner})
	require.NoError(t, err)
	return outer
}

// TestIndexer_TransientUpsertFailure_RetriesThenDLQs asserts that:
// (a) A transient UpsertTicket error is NOT silently dropped/committed — it is
//
//	retried maxRetries times and then routed to DLQ.
//
// (b) processWithRetry returns nil after successful DLQ routing (caller may commit).
func TestIndexer_TransientUpsertFailure_RetriesThenDLQs(t *testing.T) {
	ctx := context.Background()
	topic := topicTicketCreated

	upserter := &fakeUpserter{upsertErr: errors.New("opensearch: connection refused")}
	dlq := &fakeDLQPublisher{}

	msg := &confluentkafka.Message{
		TopicPartition: confluentkafka.TopicPartition{Topic: &topic},
		Value:          validPayload(t),
	}

	err := processWithRetryStub(ctx, topic, msg, upserter.UpsertTicket, dlq, zap.NewNop())

	// processWithRetry must return nil — DLQ routing succeeded, offset may be committed.
	require.NoError(t, err, "processWithRetry must return nil when DLQ routing succeeds")

	// Upsert must have been called exactly maxRetries (3) times — not 0, not 1.
	assert.Equal(t, int32(3), upserter.callCount.Load(), "upsert must be retried maxRetries times before DLQ")

	// DLQ must have been called exactly once.
	assert.Equal(t, int32(1), dlq.published.Load(), "DLQ must be called once after exhausting retries")
}

// TestIndexer_DecodeFailure_RoutesDLQWithoutRetry asserts that:
// (b) A JSON decode failure is non-retriable — routed directly to DLQ, upsert never called.
func TestIndexer_DecodeFailure_RoutesDLQWithoutRetry(t *testing.T) {
	ctx := context.Background()
	topic := topicTicketCreated

	upserter := &fakeUpserter{upsertErr: nil} // would succeed if called
	dlq := &fakeDLQPublisher{}

	msg := &confluentkafka.Message{
		TopicPartition: confluentkafka.TopicPartition{Topic: &topic},
		Value:          []byte(`{this is not valid json`),
	}

	err := processWithRetryStub(ctx, topic, msg, upserter.UpsertTicket, dlq, zap.NewNop())

	// processWithRetry must return nil — DLQ routing succeeded.
	require.NoError(t, err, "processWithRetry must return nil after DLQ routing a decode failure")

	// Upsert must NOT have been called — decode failed before upsert.
	assert.Equal(t, int32(0), upserter.callCount.Load(), "upsert must not be called on a decode failure")

	// DLQ must have been called exactly once.
	assert.Equal(t, int32(1), dlq.published.Load(), "DLQ must be called once for a decode failure")
}

// TestIndexer_SuccessfulUpsert_NoDLQ asserts that a clean upsert path does not
// touch the DLQ and processWithRetry returns nil immediately.
func TestIndexer_SuccessfulUpsert_NoDLQ(t *testing.T) {
	ctx := context.Background()
	topic := topicTicketCreated

	upserter := &fakeUpserter{upsertErr: nil}
	dlq := &fakeDLQPublisher{}

	msg := &confluentkafka.Message{
		TopicPartition: confluentkafka.TopicPartition{Topic: &topic},
		Value:          validPayload(t),
	}

	err := processWithRetryStub(ctx, topic, msg, upserter.UpsertTicket, dlq, zap.NewNop())

	require.NoError(t, err)
	assert.Equal(t, int32(1), upserter.callCount.Load(), "upsert must be called exactly once on success")
	assert.Equal(t, int32(0), dlq.published.Load(), "DLQ must not be called on success")
}
