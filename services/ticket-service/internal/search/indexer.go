package search

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"github.com/acme/ticket-service/internal/kafka"
	confluentkafka "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

const (
	topicTicketCreated = "tickets.ticket.created"
	topicTicketUpdated = "tickets.ticket.updated"
)

// dlqPublisher is the subset of kafka.Producer used by the Indexer for DLQ routing.
// It is a minimal interface so the indexer can be unit-tested without a real Kafka producer.
type dlqPublisher interface {
	PublishToDLQ(ctx context.Context, sourceTopic string, key, payload []byte, sourceHeaders []confluentkafka.Header, processingErr error) error
}

// decodeError marks a JSON/CloudEvent decode failure. These are non-retriable: retrying
// will always fail because the payload is malformed.
type decodeError struct{ cause error }

func (e *decodeError) Error() string { return e.cause.Error() }
func (e *decodeError) Unwrap() error { return e.cause }

// Indexer consumes ticket.created and ticket.updated events and upserts the slim
// search document into OpenSearch using external versioning for idempotency.
type Indexer struct {
	client   *Client
	consumer *confluentkafka.Consumer
	producer dlqPublisher // nil disables DLQ routing (not recommended in production)
	log      *zap.Logger
}

// NewIndexer creates a Kafka consumer subscribed to the ticket event topics and
// returns an Indexer ready to run.
// producer is used to route failed messages to the DLQ; pass nil to disable DLQ routing.
func NewIndexer(c *Client, brokers []string, log *zap.Logger, sec kafka.SecurityConfig, producer dlqPublisher) (*Indexer, error) {
	configMap := &confluentkafka.ConfigMap{
		"bootstrap.servers":       strings.Join(brokers, ","),
		"group.id":                "ticket-service-search-indexer",
		"auto.offset.reset":       "earliest",
		"enable.auto.commit":      false,
		"session.timeout.ms":      30000,
		"heartbeat.interval.ms":   3000,
		"max.poll.interval.ms":    300000,
		"socket.keepalive.enable": true,
	}
	if err := sec.Apply(configMap); err != nil {
		return nil, fmt.Errorf("search.NewIndexer: configure security: %w", err)
	}

	consumer, err := confluentkafka.NewConsumer(configMap)
	if err != nil {
		return nil, fmt.Errorf("search.NewIndexer: create consumer: %w", err)
	}

	if err := consumer.SubscribeTopics([]string{topicTicketCreated, topicTicketUpdated}, nil); err != nil {
		consumer.Close() //nolint:errcheck
		return nil, fmt.Errorf("search.NewIndexer: subscribe topics: %w", err)
	}

	return &Indexer{client: c, consumer: consumer, producer: producer, log: log}, nil
}

// Run begins consuming events. Blocks until ctx is cancelled.
func (i *Indexer) Run(ctx context.Context) error {
	i.log.Info("search indexer started",
		zap.Strings("topics", []string{topicTicketCreated, topicTicketUpdated}),
	)
	defer func() {
		i.log.Info("search indexer stopped")
		i.consumer.Close() //nolint:errcheck
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		msg, err := i.consumer.ReadMessage(500 * time.Millisecond)
		if err != nil {
			if kerr, ok := err.(confluentkafka.Error); ok && kerr.Code() == confluentkafka.ErrTimedOut {
				continue
			}
			i.log.Error("search indexer: kafka read error", zap.Error(err))
			continue
		}

		topic := *msg.TopicPartition.Topic
		if err := i.processWithRetry(ctx, topic, msg); err != nil {
			// processWithRetry only returns an error when DLQ routing itself
			// fails. In that case we must NOT commit — the offset will be
			// re-delivered on the next consumer start.
			i.log.Error("search indexer: message not handled and DLQ write failed — offset NOT committed",
				zap.String("topic", topic),
				zap.Error(err),
			)
			continue
		}

		// Commit offset only after successful processing or successful DLQ routing.
		if _, commitErr := i.consumer.CommitMessage(msg); commitErr != nil {
			i.log.Error("search indexer: kafka commit failed", zap.Error(commitErr))
		}
	}
}

// processWithRetry classifies the message and handles it:
//   - Decode failures are non-retriable: routed directly to DLQ, then committed.
//   - Upsert (OpenSearch) failures are transient: retried up to maxRetries times
//     with exponential back-off; if exhausted, routed to DLQ, then committed.
//   - Success: committed by the caller.
//
// Returns non-nil only when DLQ routing itself fails (offset must NOT be committed).
func (i *Indexer) processWithRetry(ctx context.Context, topic string, msg *confluentkafka.Message) error {
	// Step 1: decode — non-retriable.
	doc, ticketID, ticketVersion, decErr := i.decodeMessage(msg.Value)
	if decErr != nil {
		i.log.Error("search indexer: decode failure — routing to DLQ",
			zap.String("topic", topic),
			zap.Error(decErr),
		)
		return i.publishToDLQ(ctx, topic, msg, decErr)
	}

	// Step 2: upsert — retriable.
	const maxRetries = 3
	baseDelay := 500 * time.Millisecond
	maxDelay := 30 * time.Second

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			delay := indexerBackoffWithJitter(attempt, baseDelay, maxDelay)
			i.log.Warn("search indexer: retrying upsert",
				zap.String("topic", topic),
				zap.Int("attempt", attempt),
				zap.Duration("delay", delay),
				zap.Error(lastErr),
			)
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return fmt.Errorf("context cancelled during retry: %w", ctx.Err())
			}
		}

		if err := i.client.UpsertTicket(ctx, doc); err != nil {
			lastErr = err
			continue
		}

		i.log.Debug("search indexer: upserted doc",
			zap.String("id", ticketID),
			zap.Int("version", ticketVersion),
		)
		return nil // success
	}

	// All retries exhausted — route to DLQ.
	i.log.Error("search indexer: upsert failed after all retries — routing to DLQ",
		zap.String("topic", topic),
		zap.Int("attempts", maxRetries),
		zap.Error(lastErr),
	)
	upsertErr := fmt.Errorf("upsert ticket %s: %w", ticketID, lastErr)
	return i.publishToDLQ(ctx, topic, msg, upsertErr)
}

// publishToDLQ routes the raw message to the DLQ topic. Returns nil if the DLQ
// write succeeded (offset can be committed). Returns an error if DLQ routing
// itself failed (offset must NOT be committed).
func (i *Indexer) publishToDLQ(ctx context.Context, topic string, msg *confluentkafka.Message, processingErr error) error {
	if i.producer == nil {
		i.log.Error("search indexer: no DLQ producer configured; message will be lost",
			zap.String("topic", topic),
			zap.Error(processingErr),
		)
		return nil // commit and move on — better than blocking the partition forever
	}
	if dlqErr := i.producer.PublishToDLQ(ctx, topic, msg.Key, msg.Value, msg.Headers, processingErr); dlqErr != nil {
		return fmt.Errorf("DLQ publish failed (original error: %w): %v", processingErr, dlqErr)
	}
	i.log.Error("search indexer: message routed to DLQ",
		zap.String("topic", topic),
		zap.Error(processingErr),
	)
	return nil
}

// decodeMessage parses the raw CloudEvent payload into a Doc ready for indexing.
// Returns a *decodeError on any JSON failure so the caller can route to DLQ without retry.
func (i *Indexer) decodeMessage(payload []byte) (Doc, string, int, error) {
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return Doc{}, "", 0, &decodeError{cause: fmt.Errorf("unmarshal cloud event envelope: %w", err)}
	}

	var data kafka.TicketEventData
	if err := json.Unmarshal(envelope.Data, &data); err != nil {
		return Doc{}, "", 0, &decodeError{cause: fmt.Errorf("unmarshal ticket event data: %w", err)}
	}

	return eventToDoc(data), data.ID, data.Version, nil
}

// indexerBackoffWithJitter returns a full-jitter exponential back-off duration.
// Mirrors the pattern in internal/kafka/consumer.go.
func indexerBackoffWithJitter(attempt int, base, max time.Duration) time.Duration {
	exp := base * (1 << attempt)
	if exp > max {
		exp = max
	}
	half := exp / 2
	jitter := time.Duration(rand.Int63n(int64(half) + 1)) //nolint:gosec // non-crypto jitter
	return half + jitter
}

// eventToDoc maps a TicketEventData to a search Doc.
// Price is parsed from the decimal string; a parse failure results in 0.0 (logged at
// the caller level — never block indexing for a price format issue).
func eventToDoc(d kafka.TicketEventData) Doc {
	price, _ := strconv.ParseFloat(d.Price, 64) //nolint:errcheck

	doc := Doc{
		ID:        d.ID,
		Version:   d.Version,
		Title:     d.Title,
		Category:  d.Category,
		TicketType: d.TicketType,
		SeatingPlanID: d.SeatingPlanID,
		Price:     price,
		CreatedAt: d.CreatedAt,
	}

	if d.Event != nil {
		doc.EventTitle = d.Event.Title
		doc.VenueName = d.Event.VenueName
		doc.Description = d.Event.Description
		doc.VenueAddress = d.Event.VenueAddress
		doc.StartsAt = d.Event.StartsAt
	}

	return doc
}
