// Package kafka provides Kafka producer and consumer bootstrap for venue-service.
package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
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
func NewProducer(brokers []string, log *zap.Logger) (*Producer, error) {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  strings.Join(brokers, ","),
		"acks":               "all",
		"enable.idempotence": true,
	})
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

// OrderConsumer consumes order lifecycle events that affect seated reservations.
type OrderConsumer struct {
	consumer *kafka.Consumer
	handler  OrderEventHandler
	log      *zap.Logger
}

// NewOrderConsumer creates a Kafka consumer subscribed to order lifecycle topics.
func NewOrderConsumer(brokers []string, groupID string, handler OrderEventHandler, log *zap.Logger) (*OrderConsumer, error) {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  strings.Join(brokers, ","),
		"group.id":           groupID,
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	})
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

	return &OrderConsumer{consumer: c, handler: handler, log: log}, nil
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
			if processErr := oc.processMessage(ctx, topic, msg.Value); processErr != nil {
				oc.log.Error("failed to process kafka message",
					zap.String("topic", topic),
					zap.Error(processErr),
				)
				// Do not commit — message will be redelivered.
				continue
			}

			if _, err := oc.consumer.CommitMessage(msg); err != nil {
				oc.log.Error("kafka commit failed", zap.Error(err))
			}
		}
	}
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
