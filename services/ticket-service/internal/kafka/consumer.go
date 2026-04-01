package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

const (
	maxRetries     = 3
	baseRetryDelay = 1 * time.Second
	maxRetryDelay  = 30 * time.Second
)

// TopicOrderCreated is the Kafka topic the order-service publishes to when an order is created.
const TopicOrderCreated = "orders.order.created"

// TopicOrderCancelled is the Kafka topic the order-service publishes to when an order is cancelled.
const TopicOrderCancelled = "orders.order.cancelled"

// TopicOrderCompleted is the Kafka topic the order-service publishes to when payment is captured.
const TopicOrderCompleted = "orders.order.completed"

// TopicOrderCompletedDLQ is the dead-letter topic for failed orders.order.completed messages.
const TopicOrderCompletedDLQ = "orders.order.completed.dlq"

// orderCreatedEvent is the CloudEvents envelope for an orders.order.created event.
// The new GA flow includes reservationId and quantity; the legacy orderId path is
// kept for backward compatibility during rollout.
type orderCreatedEvent struct {
	Type string           `json:"type"`
	Data orderCreatedData `json:"data"`
}

type orderCreatedData struct {
	OrderID       string `json:"orderId"`
	TicketID      string `json:"ticketId"`
	ReservationID string `json:"reservationId,omitempty"` // new GA field
	Quantity      int    `json:"quantity,omitempty"`      // new GA field (default 1)
}

// orderCancelledEvent is the CloudEvents envelope for an orders.order.cancelled event.
type orderCancelledEvent struct {
	Type string             `json:"type"`
	Data orderCancelledData `json:"data"`
}

type orderCancelledData struct {
	OrderID       string `json:"orderId"`
	TicketID      string `json:"ticketId"`
	ReservationID string `json:"reservationId,omitempty"` // new GA field
}

// orderCompletedEvent is the CloudEvents envelope for an orders.order.completed event.
// Emitted by order-service when payment is captured.
type orderCompletedEvent struct {
	Type string             `json:"type"`
	Data orderCompletedData `json:"data"`
}

type orderCompletedData struct {
	OrderID       string `json:"orderId"`
	TicketID      string `json:"ticketId"`
	ReservationID string `json:"reservationId"` // required for GA finalize
	Quantity      int    `json:"quantity,omitempty"`
}

// TicketReserver is the interface the consumer uses to manage ticket reservation state.
// The real repository and test mocks both implement this.
type TicketReserver interface {
	// --- Legacy single-unit methods (kept for backward compat) ---

	// ReserveTicket atomically sets ticket.orderId = orderID.
	// It must be idempotent: setting the same orderId twice is not an error.
	ReserveTicket(ctx context.Context, ticketID, orderID string) error

	// ReleaseTicket atomically clears ticket.orderId when an order is cancelled.
	// It must be idempotent: releasing an already-released ticket is not an error.
	ReleaseTicket(ctx context.Context, ticketID string) error

	// --- Quota-based reservation lifecycle (GA flow) ---

	// ReleaseReservation transitions a RESERVED reservation to RELEASED and
	// restores availability. Idempotent.
	ReleaseReservation(ctx context.Context, reservationID string) error

	// FinalizeReservation transitions a RESERVED reservation to SOLD and records
	// the orderId. Idempotent.
	FinalizeReservation(ctx context.Context, reservationID, orderID string) error
}

// OrderConsumer listens to order domain events and keeps ticket reservation state in sync.
type OrderConsumer struct {
	consumer *kafka.Consumer
	producer *Producer
	reserver TicketReserver
	log      *zap.Logger
}

// NewOrderConsumer creates a Kafka consumer that listens to order events.
// groupID should be "ticket-service" (per the AGENTS.md convention).
// producer is used to publish failed messages to the DLQ after retries are exhausted.
func NewOrderConsumer(brokers []string, groupID string, reserver TicketReserver, producer *Producer, log *zap.Logger) (*OrderConsumer, error) {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":       joinBrokers(brokers),
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

	if err := c.SubscribeTopics([]string{TopicOrderCreated, TopicOrderCancelled, TopicOrderCompleted}, nil); err != nil {
		c.Close() //nolint:errcheck
		return nil, fmt.Errorf("subscribe to order topics: %w", err)
	}

	return &OrderConsumer{consumer: c, producer: producer, reserver: reserver, log: log}, nil
}

// Start begins consuming messages. It blocks until ctx is cancelled.
// Designed to run in a dedicated goroutine.
func (oc *OrderConsumer) Start(ctx context.Context) {
	oc.log.Info("order consumer started",
		zap.Strings("topics", []string{TopicOrderCreated, TopicOrderCancelled, TopicOrderCompleted}),
	)

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
		if err := oc.processWithRetry(ctx, topic, msg); err != nil {
			oc.log.Error("message processing failed after all retries and DLQ write",
				zap.String("topic", topic),
				zap.Error(err),
			)
		}

		// Commit offset only after successful processing or after DLQ routing.
		// Per AGENTS.md §3.5: commit offsets AFTER successful processing.
		if _, err := oc.consumer.CommitMessage(msg); err != nil {
			oc.log.Error("failed to commit kafka offset", zap.Error(err))
		}
	}
}

// processWithRetry attempts to handle the message up to maxRetries times with
// exponential back-off + jitter between attempts. If all retries are exhausted,
// the raw message is published to the dead-letter topic.
func (oc *OrderConsumer) processWithRetry(ctx context.Context, topic string, msg *kafka.Message) error {
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

		if err := oc.handleMessage(ctx, topic, msg.Value); err != nil {
			lastErr = err
			continue
		}
		return nil // success
	}

	// All retries exhausted — publish to DLQ so the message is never silently lost.
	if oc.producer != nil {
		if dlqErr := oc.producer.PublishToDLQ(ctx, topic, msg.Key, msg.Value, lastErr); dlqErr != nil {
			return fmt.Errorf("publish to DLQ failed (original error: %w): %v", lastErr, dlqErr)
		}
		oc.log.Error("message routed to DLQ after exhausting retries",
			zap.String("topic", topic),
			zap.Int("attempts", maxRetries),
			zap.Error(lastErr),
		)
		return nil // DLQ write succeeded; offset can be committed
	}

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

func (oc *OrderConsumer) handleMessage(ctx context.Context, topic string, payload []byte) error {
	switch topic {
	case TopicOrderCreated:
		return oc.handleOrderCreated(ctx, payload)
	case TopicOrderCancelled:
		return oc.handleOrderCancelled(ctx, payload)
	case TopicOrderCompleted:
		return oc.handleOrderCompleted(ctx, payload)
	default:
		oc.log.Warn("received message from unexpected topic", zap.String("topic", topic))
		return nil
	}
}

// handleOrderCreated handles orders.order.created events.
//
// GA path: if the event carries a reservationId, the reservation was already
// created by order-service before publishing. No further action is required for
// the reservation itself — the legacy orderId path (setting orderId on the ticket)
// is preserved for backward compatibility during rollout.
func (oc *OrderConsumer) handleOrderCreated(ctx context.Context, payload []byte) error {
	var event orderCreatedEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return fmt.Errorf("unmarshal order.created event: %w", err)
	}

	ticketID := event.Data.TicketID
	orderID := event.Data.OrderID

	// GA path: reservation already created via synchronous gRPC ReserveQuota — nothing to do.
	if event.Data.ReservationID != "" {
		oc.log.Info("order.created: GA reservation already created, skipping legacy orderId set",
			zap.String("ticketId", ticketID),
			zap.String("orderId", orderID),
			zap.String("reservationId", event.Data.ReservationID),
		)
		return nil
	}

	// Legacy path: set orderId on the ticket document.
	if ticketID == "" || orderID == "" {
		return fmt.Errorf("order.created event missing ticketId or orderId: %s", string(payload))
	}

	oc.log.Info("order.created: reserving ticket (legacy orderId path)",
		zap.String("ticketId", ticketID),
		zap.String("orderId", orderID),
	)

	if err := oc.reserver.ReserveTicket(ctx, ticketID, orderID); err != nil {
		return fmt.Errorf("reserve ticket %s for order %s: %w", ticketID, orderID, err)
	}

	oc.log.Info("ticket reserved", zap.String("ticketId", ticketID), zap.String("orderId", orderID))
	return nil
}

// handleOrderCancelled handles orders.order.cancelled events.
//
// GA path: if the event carries a reservationId, call ReleaseReservation (idempotent).
// Legacy path: fall back to clearing orderId on the ticket document.
func (oc *OrderConsumer) handleOrderCancelled(ctx context.Context, payload []byte) error {
	var event orderCancelledEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return fmt.Errorf("unmarshal order.cancelled event: %w", err)
	}

	// GA path: release the quota-based reservation.
	if event.Data.ReservationID != "" {
		oc.log.Info("order.cancelled: releasing quota reservation",
			zap.String("reservationId", event.Data.ReservationID),
			zap.String("orderId", event.Data.OrderID),
		)
		if err := oc.reserver.ReleaseReservation(ctx, event.Data.ReservationID); err != nil {
			return fmt.Errorf("release reservation %s: %w", event.Data.ReservationID, err)
		}
		oc.log.Info("quota reservation released", zap.String("reservationId", event.Data.ReservationID))
		return nil
	}

	// Legacy path: clear orderId from ticket document.
	ticketID := event.Data.TicketID
	orderID := event.Data.OrderID
	if ticketID == "" {
		return fmt.Errorf("order.cancelled event missing ticketId and reservationId: %s", string(payload))
	}

	oc.log.Info("order.cancelled: releasing ticket (legacy orderId path)",
		zap.String("ticketId", ticketID),
		zap.String("orderId", orderID),
	)

	if err := oc.reserver.ReleaseTicket(ctx, ticketID); err != nil {
		return fmt.Errorf("release ticket %s: %w", ticketID, err)
	}

	oc.log.Info("ticket released", zap.String("ticketId", ticketID), zap.String("orderId", orderID))
	return nil
}

// handleOrderCompleted handles orders.order.completed events (payment captured).
//
// GA path: calls FinalizeReservation to transition the reservation from RESERVED → SOLD
// and move the quantity from reserved to sold on the ticket. Idempotent.
func (oc *OrderConsumer) handleOrderCompleted(ctx context.Context, payload []byte) error {
	var event orderCompletedEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return fmt.Errorf("unmarshal order.completed event: %w", err)
	}

	reservationID := event.Data.ReservationID
	orderID := event.Data.OrderID

	if reservationID == "" {
		return fmt.Errorf("order.completed event missing reservationId: %s", string(payload))
	}
	if orderID == "" {
		return fmt.Errorf("order.completed event missing orderId: %s", string(payload))
	}

	oc.log.Info("order.completed: finalizing reservation",
		zap.String("reservationId", reservationID),
		zap.String("orderId", orderID),
	)

	if err := oc.reserver.FinalizeReservation(ctx, reservationID, orderID); err != nil {
		return fmt.Errorf("finalize reservation %s for order %s: %w", reservationID, orderID, err)
	}

	oc.log.Info("reservation finalized",
		zap.String("reservationId", reservationID),
		zap.String("orderId", orderID),
	)
	return nil
}
