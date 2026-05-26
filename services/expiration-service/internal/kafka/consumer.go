package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"sync"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

const (
	maxRetries     = 3
	baseRetryDelay = 1 * time.Second
	maxRetryDelay  = 30 * time.Second
)

// OrderCreatedHandler is the callback invoked when an orders.order.created event arrives.
type OrderCreatedHandler func(ctx context.Context, data OrderCreatedData) error

// Consumer wraps the Confluent Kafka consumer for the orders.order.created topic.
type Consumer struct {
	c        *confluent.Consumer
	producer *Producer
	log      *zap.Logger
	closeOnce sync.Once
}

// NewConsumer creates a Kafka consumer subscribed to TopicOrderCreated.
// producer is used to route failed messages to the DLQ after retries are exhausted.
func NewConsumer(brokers []string, groupID string, producer *Producer, log *zap.Logger, security ...SecurityConfig) (*Consumer, error) {
	brokersStr := joinBrokers(brokers)

	configMap := &confluent.ConfigMap{
		"bootstrap.servers":       brokersStr,
		"group.id":                groupID,
		"auto.offset.reset":       "earliest",
		"enable.auto.commit":      false, // Manual offset commit after successful processing
		"session.timeout.ms":      30000,
		"max.poll.interval.ms":    300000,
		"fetch.wait.max.ms":       500,
		"socket.keepalive.enable": true,
	}
	if err := firstSecurityConfig(security).Apply(configMap); err != nil {
		return nil, fmt.Errorf("configure kafka consumer security: %w", err)
	}

	c, err := confluent.NewConsumer(configMap)
	if err != nil {
		return nil, fmt.Errorf("create kafka consumer: %w", err)
	}

	if err := c.Subscribe(TopicOrderCreated, nil); err != nil {
		c.Close() //nolint:errcheck
		return nil, fmt.Errorf("subscribe to %s: %w", TopicOrderCreated, err)
	}

	return &Consumer{c: c, producer: producer, log: log}, nil
}

// Start begins consuming messages and calls handler for each valid OrderCreated event.
// It blocks until ctx is cancelled. Offset is committed only after successful handler execution
// or after a successful DLQ write.
func (c *Consumer) Start(ctx context.Context, handler OrderCreatedHandler) {
	c.log.Info("kafka consumer started", zap.String("topic", TopicOrderCreated))

	for {
		select {
		case <-ctx.Done():
			c.log.Info("kafka consumer stopping")
			c.Close()
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
			c.log.Error("failed to process message after retries and DLQ write",
				zap.String("topic", TopicOrderCreated),
				zap.String("key", string(msg.Key)),
				zap.Error(err),
			)
		}

		// Commit offset after processing (success or DLQ).
		// Per AGENTS.md §3.5: commit offsets AFTER successful processing.
		if _, err := c.c.CommitMessage(msg); err != nil {
			c.log.Error("failed to commit kafka offset", zap.Error(err))
		}
	}
}

// processMessage deserialises and handles a single Kafka message with up to maxRetries attempts.
// Uses exponential back-off with full jitter (R-10 fix — was quadratic 100ms*attempt^2).
// After all retries are exhausted, the message is published to the DLQ (R-04).
func (c *Consumer) processMessage(ctx context.Context, msg *confluent.Message, handler OrderCreatedHandler) error {
	processCtx, span := startKafkaConsumerSpan(ctx, TopicOrderCreated, msg.Headers)
	defer span.End()

	var envelope CloudEvent
	if err := json.Unmarshal(msg.Value, &envelope); err != nil {
		recordSpanError(span, err)
		return fmt.Errorf("unmarshal cloud event: %w", err)
	}

	var data OrderCreatedData
	if err := json.Unmarshal(envelope.Data, &data); err != nil {
		recordSpanError(span, err)
		return fmt.Errorf("unmarshal order created data: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			// R-10: exponential back-off with full jitter (was quadratic attempt*attempt*100ms)
			delay := exponentialBackoffWithJitter(attempt, baseRetryDelay, maxRetryDelay)
			c.log.Warn("order created handler failed, retrying",
				zap.String("orderId", data.OrderID),
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

		if err := handler(processCtx, data); err != nil {
			lastErr = err
			continue
		}
		return nil // success
	}

	// All retries exhausted — route to DLQ so the message is never silently lost (R-04).
	if c.producer != nil {
		recordSpanError(span, lastErr)
		if dlqErr := c.producer.PublishToDLQ(processCtx, TopicOrderCreated, msg.Key, msg.Value, msg.Headers, lastErr); dlqErr != nil {
			recordSpanError(span, dlqErr)
			return fmt.Errorf("publish to DLQ failed (original error: %w): %v", lastErr, dlqErr)
		}
		c.log.Error("message routed to DLQ after exhausting retries",
			zap.String("topic", TopicOrderCreated),
			zap.Int("attempts", maxRetries),
			zap.Error(lastErr),
		)
		return nil // DLQ write succeeded; offset can be committed
	}

	recordSpanError(span, lastErr)
	return fmt.Errorf("handler failed after %d attempts (no DLQ producer configured): %w", maxRetries, lastErr)
}

// exponentialBackoffWithJitter returns a duration using full-jitter exponential back-off.
// Formula: rand in [base*2^attempt/2, base*2^attempt], capped at max.
func exponentialBackoffWithJitter(attempt int, base, max time.Duration) time.Duration {
	exp := base * (1 << attempt) // base * 2^attempt
	if exp > max {
		exp = max
	}
	half := exp / 2
	jitter := time.Duration(rand.Int63n(int64(half) + 1)) //nolint:gosec // non-crypto jitter
	return half + jitter
}

// Close closes the underlying Kafka consumer.
func (c *Consumer) Close() {
	c.closeOnce.Do(func() {
		if err := c.c.Close(); err != nil {
			c.log.Error("failed to close kafka consumer", zap.Error(err))
		}
	})
}
