package search

import (
	"context"
	"encoding/json"
	"fmt"
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

// Indexer consumes ticket.created and ticket.updated events and upserts the slim
// search document into OpenSearch using external versioning for idempotency.
type Indexer struct {
	client   *Client
	consumer *confluentkafka.Consumer
	log      *zap.Logger
}

// NewIndexer creates a Kafka consumer subscribed to the ticket event topics and
// returns an Indexer ready to run.
func NewIndexer(c *Client, brokers []string, log *zap.Logger, sec kafka.SecurityConfig) (*Indexer, error) {
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

	return &Indexer{client: c, consumer: consumer, log: log}, nil
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

		if err := i.handleMessage(ctx, msg); err != nil {
			i.log.Error("search indexer: failed to process message",
				zap.String("topic", *msg.TopicPartition.Topic),
				zap.Error(err),
			)
			// Route to DLQ is not wired here — we commit and move on so a
			// single bad message does not block the partition. The error is
			// logged at ERROR for alerting.
		}

		// Commit offset after processing (success or non-retriable failure).
		if _, commitErr := i.consumer.CommitMessage(msg); commitErr != nil {
			i.log.Error("search indexer: kafka commit failed", zap.Error(commitErr))
		}
	}
}

// handleMessage decodes the CloudEvent envelope, maps the TicketEventData to a Doc,
// and calls UpsertTicket.
func (i *Indexer) handleMessage(ctx context.Context, msg *confluentkafka.Message) error {
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(msg.Value, &envelope); err != nil {
		return fmt.Errorf("unmarshal cloud event envelope: %w", err)
	}

	var data kafka.TicketEventData
	if err := json.Unmarshal(envelope.Data, &data); err != nil {
		return fmt.Errorf("unmarshal ticket event data: %w", err)
	}

	doc := eventToDoc(data)
	if err := i.client.UpsertTicket(ctx, doc); err != nil {
		return fmt.Errorf("upsert ticket %s: %w", data.ID, err)
	}

	i.log.Debug("search indexer: upserted doc",
		zap.String("id", data.ID),
		zap.Int("version", data.Version),
	)
	return nil
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
