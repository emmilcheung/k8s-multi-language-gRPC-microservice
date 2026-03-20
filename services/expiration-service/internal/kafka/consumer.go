package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

// OrderCreatedHandler is the callback invoked when an orders.order.created event arrives.
type OrderCreatedHandler func(ctx context.Context, data OrderCreatedData) error

// Consumer wraps the Confluent Kafka consumer for the orders.order.created topic.
type Consumer struct {
	c   *confluent.Consumer
	log *zap.Logger
}

// NewConsumer creates a Kafka consumer subscribed to TopicOrderCreated.
func NewConsumer(brokers []string, groupID string, log *zap.Logger) (*Consumer, error) {
	brokersStr := joinBrokers(brokers)

	c, err := confluent.NewConsumer(&confluent.ConfigMap{
		"bootstrap.servers":       brokersStr,
		"group.id":                groupID,
		"auto.offset.reset":       "earliest",
		"enable.auto.commit":      false, // Manual offset commit after successful processing
		"session.timeout.ms":      30000,
		"max.poll.interval.ms":    300000,
		"fetch.wait.max.ms":       500,
		"socket.keepalive.enable": true,
	})
	if err != nil {
		return nil, fmt.Errorf("create kafka consumer: %w", err)
	}

	if err := c.Subscribe(TopicOrderCreated, nil); err != nil {
		c.Close() //nolint:errcheck
		return nil, fmt.Errorf("subscribe to %s: %w", TopicOrderCreated, err)
	}

	return &Consumer{c: c, log: log}, nil
}

// Start begins consuming messages and calls handler for each valid OrderCreated event.
// It blocks until ctx is cancelled. Offset is committed only after successful handler execution.
// On handler failure, it retries up to maxRetries times with exponential back-off,
// then logs to DLQ (structured log — actual DLQ topic routing via the producer).
func (c *Consumer) Start(ctx context.Context, handler OrderCreatedHandler) {
	c.log.Info("kafka consumer started", zap.String("topic", TopicOrderCreated))

	for {
		select {
		case <-ctx.Done():
			c.log.Info("kafka consumer stopping")
			return
		default:
		}

		msg, err := c.c.ReadMessage(500 * time.Millisecond)
		if err != nil {
			if kafkaErr, ok := err.(confluent.Error); ok && kafkaErr.Code() == confluent.ErrTimedOut {
				// No message available within poll timeout — normal, continue.
				continue
			}
			c.log.Error("kafka read error", zap.Error(err))
			continue
		}

		if err := c.processMessage(ctx, msg, handler); err != nil {
			c.log.Error("failed to process message after retries; routing to DLQ",
				zap.String("topic", TopicOrderCreated),
				zap.String("key", string(msg.Key)),
				zap.Error(err),
			)
			// Commit offset even on DLQ to avoid infinite reprocessing.
		}

		// Commit offset after processing (success or DLQ).
		if _, err := c.c.CommitMessage(msg); err != nil {
			c.log.Error("failed to commit kafka offset", zap.Error(err))
		}
	}
}

// processMessage deserialises and handles a single Kafka message with up to 3 retries.
func (c *Consumer) processMessage(ctx context.Context, msg *confluent.Message, handler OrderCreatedHandler) error {
	var envelope CloudEvent
	if err := json.Unmarshal(msg.Value, &envelope); err != nil {
		return fmt.Errorf("unmarshal cloud event: %w", err)
	}

	var data OrderCreatedData
	if err := json.Unmarshal(envelope.Data, &data); err != nil {
		return fmt.Errorf("unmarshal order created data: %w", err)
	}

	const maxRetries = 3
	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		if err := handler(ctx, data); err != nil {
			lastErr = err
			c.log.Warn("order created handler failed, retrying",
				zap.String("orderId", data.OrderID),
				zap.Int("attempt", attempt),
				zap.Error(err),
			)
			backoff := time.Duration(attempt*attempt) * 100 * time.Millisecond
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return fmt.Errorf("context cancelled during retry: %w", ctx.Err())
			}
			continue
		}
		return nil
	}
	return fmt.Errorf("handler failed after %d attempts: %w", maxRetries, lastErr)
}

// Close closes the underlying Kafka consumer.
func (c *Consumer) Close() {
	if err := c.c.Close(); err != nil {
		c.log.Error("failed to close kafka consumer", zap.Error(err))
	}
}
