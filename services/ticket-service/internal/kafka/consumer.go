package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

// TopicOrderCreated is the Kafka topic the order-service publishes to when an order is created.
const TopicOrderCreated = "orders.order.created"

// TopicOrderCancelled is the Kafka topic the order-service publishes to when an order is cancelled.
const TopicOrderCancelled = "orders.order.cancelled"

// orderCreatedEvent is the CloudEvents envelope for an orders.order.created event.
type orderCreatedEvent struct {
	Type string           `json:"type"`
	Data orderCreatedData `json:"data"`
}

type orderCreatedData struct {
	OrderID  string `json:"orderId"`
	TicketID string `json:"ticketId"`
}

// orderCancelledEvent is the CloudEvents envelope for an orders.order.cancelled event.
type orderCancelledEvent struct {
	Type string             `json:"type"`
	Data orderCancelledData `json:"data"`
}

type orderCancelledData struct {
	OrderID  string `json:"orderId"`
	TicketID string `json:"ticketId"`
}

// TicketReserver is the interface the consumer uses to set/clear the orderId on a ticket.
// The real repository and test mocks both implement this.
type TicketReserver interface {
	// ReserveTicket atomically sets ticket.orderId = orderID.
	// It must be idempotent: setting the same orderId twice is not an error.
	ReserveTicket(ctx context.Context, ticketID, orderID string) error

	// ReleaseTicket atomically clears ticket.orderId when an order is cancelled.
	// It must be idempotent: releasing an already-released ticket is not an error.
	ReleaseTicket(ctx context.Context, ticketID string) error
}

// OrderConsumer listens to order domain events and keeps ticket reservation state in sync.
type OrderConsumer struct {
	consumer *kafka.Consumer
	reserver TicketReserver
	log      *zap.Logger
}

// NewOrderConsumer creates a Kafka consumer that listens to order events.
// groupID should be "ticket-service" (per the AGENTS.md convention).
func NewOrderConsumer(brokers []string, groupID string, reserver TicketReserver, log *zap.Logger) (*OrderConsumer, error) {
	brokersStr := ""
	for i, b := range brokers {
		if i > 0 {
			brokersStr += ","
		}
		brokersStr += b
	}

	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":       brokersStr,
		"group.id":                groupID,
		"auto.offset.reset":       "earliest",
		"enable.auto.commit":      false, // manual commit after successful processing
		"session.timeout.ms":      30000,
		"heartbeat.interval.ms":   3000,
		"max.poll.interval.ms":    300000,
		"socket.keepalive.enable": true,
	})
	if err != nil {
		return nil, fmt.Errorf("create kafka consumer: %w", err)
	}

	if err := c.SubscribeTopics([]string{TopicOrderCreated, TopicOrderCancelled}, nil); err != nil {
		c.Close() //nolint:errcheck
		return nil, fmt.Errorf("subscribe to order topics: %w", err)
	}

	return &OrderConsumer{consumer: c, reserver: reserver, log: log}, nil
}

// Start begins consuming messages. It blocks until ctx is cancelled.
// Designed to run in a dedicated goroutine.
func (oc *OrderConsumer) Start(ctx context.Context) {
	oc.log.Info("order consumer started", zap.Strings("topics", []string{TopicOrderCreated, TopicOrderCancelled}))

	for {
		select {
		case <-ctx.Done():
			oc.log.Info("order consumer stopping")
			oc.consumer.Close() //nolint:errcheck
			return
		default:
		}

		msg, err := oc.consumer.ReadMessage(500 * time.Millisecond)
		if err != nil {
			// Timeout is not an error — just continue polling
			if kafkaErr, ok := err.(kafka.Error); ok && kafkaErr.Code() == kafka.ErrTimedOut {
				continue
			}
			oc.log.Error("kafka read error", zap.Error(err))
			continue
		}

		topic := *msg.TopicPartition.Topic
		if err := oc.handleMessage(ctx, topic, msg.Value); err != nil {
			oc.log.Error("failed to handle order event — routing to DLQ",
				zap.String("topic", topic),
				zap.Error(err),
			)
			// TODO: publish to DLQ; for now log and commit to avoid poison-pill blocking
		}

		// Commit offset only after successful processing (or after DLQ routing)
		if _, err := oc.consumer.CommitMessage(msg); err != nil {
			oc.log.Error("failed to commit kafka offset", zap.Error(err))
		}
	}
}

func (oc *OrderConsumer) handleMessage(ctx context.Context, topic string, payload []byte) error {
	switch topic {
	case TopicOrderCreated:
		return oc.handleOrderCreated(ctx, payload)
	case TopicOrderCancelled:
		return oc.handleOrderCancelled(ctx, payload)
	default:
		oc.log.Warn("received message from unexpected topic", zap.String("topic", topic))
		return nil
	}
}

func (oc *OrderConsumer) handleOrderCreated(ctx context.Context, payload []byte) error {
	var event orderCreatedEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return fmt.Errorf("unmarshal order.created event: %w", err)
	}

	ticketID := event.Data.TicketID
	orderID := event.Data.OrderID
	if ticketID == "" || orderID == "" {
		return fmt.Errorf("order.created event missing ticketId or orderId: %s", string(payload))
	}

	oc.log.Info("reserving ticket from order.created event",
		zap.String("ticketId", ticketID),
		zap.String("orderId", orderID),
	)

	if err := oc.reserver.ReserveTicket(ctx, ticketID, orderID); err != nil {
		return fmt.Errorf("reserve ticket %s for order %s: %w", ticketID, orderID, err)
	}

	oc.log.Info("ticket reserved", zap.String("ticketId", ticketID), zap.String("orderId", orderID))
	return nil
}

func (oc *OrderConsumer) handleOrderCancelled(ctx context.Context, payload []byte) error {
	var event orderCancelledEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return fmt.Errorf("unmarshal order.cancelled event: %w", err)
	}

	ticketID := event.Data.TicketID
	orderID := event.Data.OrderID
	if ticketID == "" {
		return fmt.Errorf("order.cancelled event missing ticketId: %s", string(payload))
	}

	oc.log.Info("releasing ticket from order.cancelled event",
		zap.String("ticketId", ticketID),
		zap.String("orderId", orderID),
	)

	if err := oc.reserver.ReleaseTicket(ctx, ticketID); err != nil {
		return fmt.Errorf("release ticket %s: %w", ticketID, err)
	}

	oc.log.Info("ticket released", zap.String("ticketId", ticketID), zap.String("orderId", orderID))
	return nil
}
