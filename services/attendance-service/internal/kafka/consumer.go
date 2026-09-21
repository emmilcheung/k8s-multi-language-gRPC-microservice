package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

// kafkaReader is the subset of confluent.Consumer used in the message loop.
// Extracted as an interface to allow unit testing without a real broker.
type kafkaReader interface {
	ReadMessage(timeout time.Duration) (*confluent.Message, error)
	CommitMessage(msg *confluent.Message) ([]confluent.TopicPartition, error)
}

// dlqPublisher publishes raw bytes to a dead-letter topic.
type dlqPublisher interface {
	Publish(topic string, key, value []byte) error
}

const (
	maxRetries     = 3
	baseRetryDelay = 500 * time.Millisecond
	maxRetryDelay  = 30 * time.Second
)

// CloudEvent is the CloudEvents v1.0 envelope used across the platform.
type CloudEvent struct {
	SpecVersion     string          `json:"specversion"`
	Type            string          `json:"type"`
	Source          string          `json:"source"`
	ID              string          `json:"id"`
	Time            time.Time       `json:"time"`
	DataContentType string          `json:"datacontenttype"`
	Data            json.RawMessage `json:"data"`
}

// OrderCompletedData carries the relevant fields from orders.order.completed.
type OrderCompletedData struct {
	OrderID       string `json:"orderId"`
	UserID        string `json:"userId"`
	TicketID      string `json:"ticketId"`
	ReservationID string `json:"reservationId"`
	Quantity      int    `json:"quantity"`
	Version       int    `json:"version"`
	// SeatIDs is non-empty for seated orders; one credential is issued per seat.
	// For GA orders SeatIDs is empty and one credential is issued per Quantity unit.
	SeatIDs []string `json:"seatIds"`
}

// OrderEventHandler is implemented by the service layer to process completed order events.
// WS2 will wire the credential issuance logic here.
type OrderEventHandler interface {
	OnOrderCompleted(ctx context.Context, data OrderCompletedData) error
}

// OrderConsumer listens to orders.order.completed and dispatches to OrderEventHandler.
type OrderConsumer struct {
	brokers  string
	groupID  string
	handler  OrderEventHandler
	producer dlqPublisher
	log      *zap.Logger
	security SecurityConfig
}

// NewOrderConsumer creates a new OrderConsumer.
func NewOrderConsumer(
	brokers []string,
	groupID string,
	handler OrderEventHandler,
	producer dlqPublisher,
	log *zap.Logger,
	security ...SecurityConfig,
) (*OrderConsumer, error) {
	sec := SecurityConfig{SecurityProtocol: "PLAINTEXT"}
	if len(security) > 0 {
		sec = security[0]
	}
	return &OrderConsumer{
		brokers:  strings.Join(brokers, ","),
		groupID:  groupID,
		handler:  handler,
		producer: producer,
		log:      log,
		security: sec,
	}, nil
}

// Start begins consuming messages. Blocks until ctx is cancelled.
func (c *OrderConsumer) Start(ctx context.Context) {
	configMap := &confluent.ConfigMap{
		"bootstrap.servers":    c.brokers,
		"group.id":             c.groupID,
		"auto.offset.reset":    "earliest",
		"enable.auto.commit":   false,
		"session.timeout.ms":   30000,
		"max.poll.interval.ms": 300000,
	}
	if err := c.security.Apply(configMap); err != nil {
		c.log.Error("kafka consumer: security config error", zap.Error(err))
		return
	}

	consumer, err := confluent.NewConsumer(configMap)
	if err != nil {
		c.log.Error("kafka consumer: failed to create consumer", zap.Error(err))
		return
	}
	defer consumer.Close() //nolint:errcheck

	if err := consumer.SubscribeTopics([]string{TopicOrderCompleted}, nil); err != nil {
		c.log.Error("kafka consumer: failed to subscribe", zap.Error(err))
		return
	}

	c.log.Info("kafka consumer: started", zap.String("topic", TopicOrderCompleted), zap.String("group", c.groupID))
	c.loop(ctx, consumer)
}

// loop is the consume-process-commit cycle. Extracted to allow unit testing
// against the kafkaReader interface without a real broker.
func (c *OrderConsumer) loop(ctx context.Context, reader kafkaReader) {
	for {
		select {
		case <-ctx.Done():
			c.log.Info("kafka consumer: context cancelled, stopping")
			return
		default:
		}

		msg, err := reader.ReadMessage(100 * time.Millisecond)
		if err != nil {
			if kafkaErr, ok := err.(confluent.Error); ok && kafkaErr.Code() == confluent.ErrTimedOut {
				continue
			}
			c.log.Error("kafka consumer: read error", zap.Error(err))
			continue
		}

		if processErr := c.processMessage(ctx, msg); processErr != nil {
			c.log.Error("kafka consumer: processing failed, sending to DLQ",
				zap.Error(processErr),
				zap.String("topic", *msg.TopicPartition.Topic),
			)
			if dlqErr := c.producer.Publish(TopicOrderCompletedDLQ, msg.Key, msg.Value); dlqErr != nil {
				c.log.Error("kafka consumer: DLQ publish failed, not committing offset", zap.Error(dlqErr))
				continue // do not commit — offset will be redelivered
			}
		}

		if _, commitErr := reader.CommitMessage(msg); commitErr != nil {
			c.log.Error("kafka consumer: commit failed", zap.Error(commitErr))
		}
	}
}

func (c *OrderConsumer) processMessage(ctx context.Context, msg *confluent.Message) error {
	var envelope CloudEvent
	if err := json.Unmarshal(msg.Value, &envelope); err != nil {
		return fmt.Errorf("unmarshal cloud event: %w", err)
	}

	var data OrderCompletedData
	if err := json.Unmarshal(envelope.Data, &data); err != nil {
		return fmt.Errorf("unmarshal order completed data: %w", err)
	}

	var lastErr error
	delay := baseRetryDelay
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			jitter := time.Duration(rand.Int63n(int64(delay / 2)))
			select {
			case <-ctx.Done():
				return fmt.Errorf("kafka consumer: context cancelled during retry: %w", ctx.Err())
			case <-time.After(delay + jitter):
			}
			delay = min(delay*2, maxRetryDelay)
		}
		if err := c.handler.OnOrderCompleted(ctx, data); err != nil {
			lastErr = err
			c.log.Warn("kafka consumer: handler error, retrying",
				zap.Error(err),
				zap.Int("attempt", attempt+1),
			)
			continue
		}
		return nil
	}
	return fmt.Errorf("kafka consumer: max retries exceeded: %w", lastErr)
}
