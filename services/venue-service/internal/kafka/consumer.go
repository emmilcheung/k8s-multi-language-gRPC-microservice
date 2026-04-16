// Package kafka provides Kafka producer and consumer bootstrap for venue-service.
package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

const (
	maxRetries     = 3
	baseRetryDelay = 500 * time.Millisecond
	maxRetryDelay  = 30 * time.Second
)

// DLQ topic names for failed order lifecycle events.
const (
	TopicOrderCancelledDLQ = "orders.order.cancelled.dlq"
	TopicOrderCompletedDLQ = "orders.order.completed.dlq"
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

// OrderEventData carries the relevant fields from order lifecycle events.
type OrderEventData struct {
	OrderID       string `json:"orderId"`
	ReservationID string `json:"reservationId"`
}

// OrderEventHandler is implemented by the service layer to process order events.
type OrderEventHandler interface {
	OnOrderCancelled(ctx context.Context, reservationID string) error
	OnOrderCompleted(ctx context.Context, reservationID, orderID string) error
}

// Producer wraps the confluent Kafka producer with a close helper.
type Producer struct {
	p   *kafka.Producer
	log *zap.Logger
}

// NewProducer creates a new Kafka producer configured for exactly-once delivery.
func NewProducer(brokers []string, log *zap.Logger, security ...SecurityConfig) (*Producer, error) {
	configMap := &kafka.ConfigMap{
		"bootstrap.servers":  strings.Join(brokers, ","),
		"acks":               "all",
		"enable.idempotence": true,
	}
	if err := firstSecurityConfig(security).Apply(configMap); err != nil {
		return nil, fmt.Errorf("configure kafka producer security: %w", err)
	}

	p, err := kafka.NewProducer(configMap)
	if err != nil {
		return nil, fmt.Errorf("kafka new producer: %w", err)
	}
	return &Producer{p: p, log: log}, nil
}

// Close flushes pending messages and closes the underlying producer.
func (p *Producer) Close() {
	remaining := p.p.Flush(5000)
	if remaining > 0 {
		p.log.Warn("kafka producer: messages still in queue after flush", zap.Int("remaining", remaining))
	}
	p.p.Close()
}

// PublishToDLQ routes a failed raw Kafka message to the appropriate dead-letter topic.
// The DLQ topic name is derived by appending ".dlq" to the source topic.
// The raw message bytes are forwarded unchanged so the DLQ consumer can inspect the original payload.
func (p *Producer) PublishToDLQ(ctx context.Context, sourceTopic string, key, payload []byte, sourceHeaders []kafka.Header, processingErr error) error {
	dlqTopic := sourceTopic + ".dlq"
	spanCtx, span, _ := startKafkaProducerSpan(ctx, dlqTopic)
	defer span.End()

	p.log.Error("routing message to DLQ",
		zap.String("sourceTopic", sourceTopic),
		zap.String("dlqTopic", dlqTopic),
		zap.String("key", string(key)),
		zap.Error(processingErr),
	)

	headers := append([]kafka.Header{}, sourceHeaders...)
	headers = append(headers,
		kafka.Header{Key: "x-dlq-source-topic", Value: []byte(sourceTopic)},
		kafka.Header{Key: "x-dlq-error", Value: []byte(processingErr.Error())},
	)
	headers = injectKafkaContextHeaders(spanCtx, headers)

	deliveryChan := make(chan kafka.Event, 1)
	err := p.p.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &dlqTopic, Partition: kafka.PartitionAny},
		Key:            key,
		Value:          payload,
		Headers:        headers,
	}, deliveryChan)
	if err != nil {
		recordSpanError(span, err)
		return fmt.Errorf("produce to DLQ topic %s: %w", dlqTopic, err)
	}

	select {
	case e := <-deliveryChan:
		msg := e.(*kafka.Message)
		if msg.TopicPartition.Error != nil {
			recordSpanError(span, msg.TopicPartition.Error)
			return fmt.Errorf("DLQ delivery error: %w", msg.TopicPartition.Error)
		}
		return nil
	case <-ctx.Done():
		err := fmt.Errorf("DLQ produce cancelled: %w", ctx.Err())
		recordSpanError(span, err)
		return err
	}
}

// OrderConsumer consumes order lifecycle events that affect seated reservations.
type OrderConsumer struct {
	consumer *kafka.Consumer
	producer *Producer // used to route failed messages to DLQ after retries are exhausted
	handler  OrderEventHandler
	log      *zap.Logger
}

// NewOrderConsumer creates a Kafka consumer subscribed to order lifecycle topics.
// producer is used for DLQ routing; pass nil to disable DLQ (not recommended in production).
func NewOrderConsumer(brokers []string, groupID string, handler OrderEventHandler, producer *Producer, log *zap.Logger, security ...SecurityConfig) (*OrderConsumer, error) {
	configMap := &kafka.ConfigMap{
		"bootstrap.servers":  strings.Join(brokers, ","),
		"group.id":           groupID,
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	}
	if err := firstSecurityConfig(security).Apply(configMap); err != nil {
		return nil, fmt.Errorf("configure kafka consumer security: %w", err)
	}

	c, err := kafka.NewConsumer(configMap)
	if err != nil {
		return nil, fmt.Errorf("kafka new consumer: %w", err)
	}

	topics := []string{
		"orders.order.cancelled",
		"orders.order.completed",
	}
	if err := c.SubscribeTopics(topics, nil); err != nil {
		c.Close() //nolint:errcheck
		return nil, fmt.Errorf("kafka subscribe: %w", err)
	}

	return &OrderConsumer{consumer: c, producer: producer, handler: handler, log: log}, nil
}

// Start begins consuming events. Blocks until ctx is cancelled.
func (oc *OrderConsumer) Start(ctx context.Context) {
	oc.log.Info("venue-service Kafka order consumer started")
	defer func() {
		oc.log.Info("venue-service Kafka order consumer stopped")
		oc.consumer.Close() //nolint:errcheck
	}()

	for {
		select {
		case <-ctx.Done():
			return
		default:
			msg, err := oc.consumer.ReadMessage(200 * time.Millisecond)
			if err != nil {
				if kerr, ok := err.(kafka.Error); ok && kerr.Code() == kafka.ErrTimedOut {
					continue
				}
				oc.log.Error("kafka read error", zap.Error(err))
				continue
			}

			topic := *msg.TopicPartition.Topic
			if processErr := oc.processWithRetry(ctx, topic, msg); processErr != nil {
				oc.log.Error("message processing failed after all retries and DLQ write",
					zap.String("topic", topic),
					zap.Error(processErr),
				)
				continue
			}

			// Commit only after successful processing or DLQ routing — never silently discard.
			if _, commitErr := oc.consumer.CommitMessage(msg); commitErr != nil {
				oc.log.Error("kafka commit failed", zap.Error(commitErr))
			}
		}
	}
}

// processWithRetry attempts to handle the message up to maxRetries times with
// exponential back-off + jitter between attempts. If all retries are exhausted,
// the raw message is published to the dead-letter topic.
func (oc *OrderConsumer) processWithRetry(ctx context.Context, topic string, msg *kafka.Message) error {
	processCtx, span := startKafkaConsumerSpan(ctx, topic, msg.Headers)
	defer span.End()

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			delay := exponentialBackoffWithJitter(attempt, baseRetryDelay, maxRetryDelay)
			oc.log.Warn("retrying message processing",
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

		if err := oc.processMessage(processCtx, topic, msg.Value); err != nil {
			lastErr = err
			continue
		}
		return nil // success
	}

	// All retries exhausted — route to DLQ so the message is never silently lost.
	if oc.producer != nil {
		recordSpanError(span, lastErr)
		if dlqErr := oc.producer.PublishToDLQ(processCtx, topic, msg.Key, msg.Value, msg.Headers, lastErr); dlqErr != nil {
			recordSpanError(span, dlqErr)
			return fmt.Errorf("publish to DLQ failed (original error: %w): %v", lastErr, dlqErr)
		}
		oc.log.Error("message routed to DLQ after exhausting retries",
			zap.String("topic", topic),
			zap.Int("attempts", maxRetries),
			zap.Error(lastErr),
		)
		return nil // DLQ write succeeded; offset can be committed
	}

	recordSpanError(span, lastErr)
	return fmt.Errorf("message processing failed after %d attempts (no DLQ producer configured): %w", maxRetries, lastErr)
}

// exponentialBackoffWithJitter returns a duration using full-jitter exponential back-off.
// attempt is 1-indexed. Formula: rand in [base*2^(attempt-1)/2, base*2^(attempt-1)], capped at max.
func exponentialBackoffWithJitter(attempt int, base, max time.Duration) time.Duration {
	exp := base * (1 << attempt) // base * 2^attempt
	if exp > max {
		exp = max
	}
	half := exp / 2
	jitter := time.Duration(rand.Int63n(int64(half) + 1)) //nolint:gosec // non-crypto jitter
	return half + jitter
}

func (oc *OrderConsumer) processMessage(ctx context.Context, topic string, value []byte) error {
	var event CloudEvent
	if err := json.Unmarshal(value, &event); err != nil {
		return fmt.Errorf("unmarshal cloud event: %w", err)
	}

	var data OrderEventData
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return fmt.Errorf("unmarshal event data: %w", err)
	}

	// Only process events that carry a reservationId — GA orders without a
	// seated reservation are irrelevant to venue-service.
	if data.ReservationID == "" {
		return nil
	}

	switch topic {
	case "orders.order.cancelled":
		return oc.handler.OnOrderCancelled(ctx, data.ReservationID)
	case "orders.order.completed":
		return oc.handler.OnOrderCompleted(ctx, data.ReservationID, data.OrderID)
	default:
		oc.log.Warn("venue-service: unhandled kafka topic", zap.String("topic", topic))
	}
	return nil
}
