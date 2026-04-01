package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// TopicTicketCreated is the Kafka topic for ticket creation events.
const TopicTicketCreated = "tickets.ticket.created"

// TopicTicketUpdated is the Kafka topic for ticket update events.
const TopicTicketUpdated = "tickets.ticket.updated"

// TopicOrderCreatedDLQ is the dead-letter topic for failed orders.order.created messages.
const TopicOrderCreatedDLQ = "orders.order.created.dlq"

// TopicOrderCancelledDLQ is the dead-letter topic for failed orders.order.cancelled messages.
const TopicOrderCancelledDLQ = "orders.order.cancelled.dlq"

// CloudEvent is the CloudEvents v1.0 envelope used for all Kafka events.
type CloudEvent struct {
	SpecVersion     string      `json:"specversion"`
	Type            string      `json:"type"`
	Source          string      `json:"source"`
	ID              string      `json:"id"`
	Time            string      `json:"time"`
	DataContentType string      `json:"datacontenttype"`
	Data            interface{} `json:"data"`
}

// TicketEventData is the domain payload for ticket events.
// Price is a decimal string to match the quota-based ticket model (no float drift).
// SeatingPlanID (CP-13): non-empty for seated tickets; consumers use this to route
// inventory management to the venue-service path.
type TicketEventData struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Price         string `json:"price"`
	UserID        string `json:"userId"`
	SeatingPlanID string `json:"seatingPlanId,omitempty"`
	Version       int    `json:"version"`
}

// Producer wraps the Confluent Kafka producer with structured event publishing.
type Producer struct {
	p   *kafka.Producer
	log *zap.Logger
}

// NewProducer creates a Kafka producer with idempotence and acks=all.
func NewProducer(brokers []string, log *zap.Logger) (*Producer, error) {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  joinBrokers(brokers),
		"acks":               "all",
		"enable.idempotence": true,
		"retries":            3,
		"retry.backoff.ms":   200,
		// Keep well below Kong's 10 s upstream read timeout so that a broker
		// outage (e.g. Kafka disabled in local dev) causes a fast delivery
		// failure rather than a gateway timeout visible to the caller.
		"message.timeout.ms": 3000,
	})
	if err != nil {
		return nil, fmt.Errorf("create kafka producer: %w", err)
	}

	// Start a goroutine to drain delivery reports
	go func() {
		for e := range p.Events() {
			switch ev := e.(type) {
			case *kafka.Message:
				if ev.TopicPartition.Error != nil {
					log.Error("kafka delivery failed",
						zap.String("topic", *ev.TopicPartition.Topic),
						zap.Error(ev.TopicPartition.Error),
					)
				} else {
					log.Debug("kafka message delivered",
						zap.String("topic", *ev.TopicPartition.Topic),
						zap.Int32("partition", ev.TopicPartition.Partition),
					)
				}
			}
		}
	}()

	return &Producer{p: p, log: log}, nil
}

// PublishTicketCreated publishes a ticket.created CloudEvent.
func (p *Producer) PublishTicketCreated(ctx context.Context, data TicketEventData) error {
	return p.publish(ctx, TopicTicketCreated, data.ID, TopicTicketCreated, data)
}

// PublishTicketUpdated publishes a ticket.updated CloudEvent.
func (p *Producer) PublishTicketUpdated(ctx context.Context, data TicketEventData) error {
	return p.publish(ctx, TopicTicketUpdated, data.ID, TopicTicketUpdated, data)
}

// PublishToDLQ routes a failed raw Kafka message to the appropriate dead-letter topic.
// The DLQ topic name is derived by appending ".dlq" to the source topic.
// The raw message bytes are forwarded unchanged so the DLQ consumer can inspect the original payload.
func (p *Producer) PublishToDLQ(ctx context.Context, sourceTopic string, key, payload []byte, processingErr error) error {
	dlqTopic := sourceTopic + ".dlq"

	p.log.Error("routing message to DLQ",
		zap.String("sourceTopic", sourceTopic),
		zap.String("dlqTopic", dlqTopic),
		zap.String("key", string(key)),
		zap.Error(processingErr),
	)

	deliveryChan := make(chan kafka.Event, 1)
	err := p.p.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &dlqTopic, Partition: kafka.PartitionAny},
		Key:            key,
		Value:          payload,
		Headers: []kafka.Header{
			{Key: "x-dlq-source-topic", Value: []byte(sourceTopic)},
			{Key: "x-dlq-error", Value: []byte(processingErr.Error())},
		},
	}, deliveryChan)
	if err != nil {
		return fmt.Errorf("produce to DLQ topic %s: %w", dlqTopic, err)
	}

	select {
	case e := <-deliveryChan:
		msg := e.(*kafka.Message)
		if msg.TopicPartition.Error != nil {
			return fmt.Errorf("DLQ delivery error: %w", msg.TopicPartition.Error)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("DLQ produce cancelled: %w", ctx.Err())
	}
}

func (p *Producer) publish(ctx context.Context, topic, partitionKey, eventType string, data interface{}) error {
	event := CloudEvent{
		SpecVersion:     "1.0",
		Type:            eventType,
		Source:          "ticket-service",
		ID:              uuid.NewString(),
		Time:            time.Now().UTC().Format(time.RFC3339),
		DataContentType: "application/json",
		Data:            data,
	}

	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal cloud event: %w", err)
	}

	deliveryChan := make(chan kafka.Event, 1)
	err = p.p.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
		Key:            []byte(partitionKey),
		Value:          payload,
	}, deliveryChan)
	if err != nil {
		return fmt.Errorf("kafka produce: %w", err)
	}

	// Wait for delivery or context cancellation
	select {
	case e := <-deliveryChan:
		msg := e.(*kafka.Message)
		if msg.TopicPartition.Error != nil {
			return fmt.Errorf("kafka delivery error: %w", msg.TopicPartition.Error)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("kafka produce cancelled: %w", ctx.Err())
	}
}

// Close flushes pending messages and closes the producer.
func (p *Producer) Close() {
	remaining := p.p.Flush(10 * 1000) // 10 seconds
	if remaining > 0 {
		p.log.Warn("kafka producer flushed with messages remaining", zap.Int("remaining", remaining))
	}
	p.p.Close()
}
