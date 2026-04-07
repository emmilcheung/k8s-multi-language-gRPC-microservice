package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// TopicOrderCreated is the topic this service consumes.
const TopicOrderCreated = "orders.order.created"

// TopicExpirationComplete is the topic this service produces to.
const TopicExpirationComplete = "expiration.order.expiration_complete"

// TopicExpirationCompleteDLQ is the dead-letter topic for failed expiration events.
const TopicExpirationCompleteDLQ = "expiration.order.expiration_complete.dlq"

// CloudEvent is the CloudEvents v1.0 envelope used for all Kafka events.
type CloudEvent struct {
	SpecVersion     string          `json:"specversion"`
	Type            string          `json:"type"`
	Source          string          `json:"source"`
	ID              string          `json:"id"`
	Time            string          `json:"time"`
	DataContentType string          `json:"datacontenttype"`
	Data            json.RawMessage `json:"data"`
}

// OrderCreatedData is the domain payload of the orders.order.created event.
type OrderCreatedData struct {
	OrderID     string  `json:"orderId"`
	UserID      string  `json:"userId"`
	TicketID    string  `json:"ticketId"`
	TicketTitle string  `json:"ticketTitle"`
	TicketPrice float64 `json:"ticketPrice"`
	ExpiresAt   string  `json:"expiresAt"` // ISO-8601
	Version     int     `json:"version"`
}

// ExpirationCompleteData is the domain payload of the expiration.order.expiration_complete event.
type ExpirationCompleteData struct {
	OrderID string `json:"orderId"`
}

// Producer wraps the Confluent Kafka producer with structured event publishing.
type Producer struct {
	p   *confluent.Producer
	log *zap.Logger
}

// NewProducer creates a Kafka producer with idempotence and acks=all.
func NewProducer(brokers []string, log *zap.Logger) (*Producer, error) {
	brokersStr := joinBrokers(brokers)

	p, err := confluent.NewProducer(&confluent.ConfigMap{
		"bootstrap.servers":  brokersStr,
		"acks":               "all",
		"enable.idempotence": true,
		"retries":            3,
		"retry.backoff.ms":   200,
		"message.timeout.ms": 10000,
	})
	if err != nil {
		return nil, fmt.Errorf("create kafka producer: %w", err)
	}

	// Drain delivery reports in the background.
	go func() {
		for e := range p.Events() {
			switch ev := e.(type) {
			case *confluent.Message:
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

// PublishExpirationComplete publishes an expiration.order.expiration_complete CloudEvent.
func (p *Producer) PublishExpirationComplete(ctx context.Context, orderID string) error {
	_, span, headers := startKafkaProducerSpan(ctx, TopicExpirationComplete)
	defer span.End()

	data := ExpirationCompleteData{OrderID: orderID}

	dataBytes, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal expiration data: %w", err)
	}

	event := CloudEvent{
		SpecVersion:     "1.0",
		Type:            TopicExpirationComplete,
		Source:          "expiration-service",
		ID:              uuid.NewString(),
		Time:            time.Now().UTC().Format(time.RFC3339),
		DataContentType: "application/json",
		Data:            dataBytes,
	}

	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal cloud event: %w", err)
	}

	topic := TopicExpirationComplete
	deliveryChan := make(chan confluent.Event, 1)
	err = p.p.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &topic, Partition: confluent.PartitionAny},
		Key:            []byte(orderID),
		Value:          payload,
		Headers:        headers,
	}, deliveryChan)
	if err != nil {
		recordSpanError(span, err)
		return fmt.Errorf("kafka produce: %w", err)
	}

	select {
	case e := <-deliveryChan:
		msg := e.(*confluent.Message)
		if msg.TopicPartition.Error != nil {
			recordSpanError(span, msg.TopicPartition.Error)
			return fmt.Errorf("kafka delivery error: %w", msg.TopicPartition.Error)
		}
		return nil
	case <-ctx.Done():
		err := fmt.Errorf("kafka produce cancelled: %w", ctx.Err())
		recordSpanError(span, err)
		return err
	}
}

// PublishToDLQ routes a failed raw Kafka message to the dead-letter topic.
// Headers carry the source topic and the error that caused the failure for observability.
func (p *Producer) PublishToDLQ(ctx context.Context, sourceTopic string, key, payload []byte, sourceHeaders []confluent.Header, processingErr error) error {
	dlqTopic := TopicExpirationCompleteDLQ
	spanCtx, span, _ := startKafkaProducerSpan(ctx, dlqTopic)
	defer span.End()

	p.log.Error("routing message to DLQ",
		zap.String("sourceTopic", sourceTopic),
		zap.String("dlqTopic", dlqTopic),
		zap.String("key", string(key)),
		zap.Error(processingErr),
	)

	headers := append([]confluent.Header{}, sourceHeaders...)
	headers = append(headers,
		confluent.Header{Key: "x-dlq-source-topic", Value: []byte(sourceTopic)},
		confluent.Header{Key: "x-dlq-error", Value: []byte(processingErr.Error())},
	)
	headers = injectKafkaContextHeaders(spanCtx, headers)

	deliveryChan := make(chan confluent.Event, 1)
	err := p.p.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &dlqTopic, Partition: confluent.PartitionAny},
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
		msg := e.(*confluent.Message)
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

// Close flushes pending messages and closes the producer.
func (p *Producer) Close() {
	remaining := p.p.Flush(10 * 1000) // 10 seconds
	if remaining > 0 {
		p.log.Warn("kafka producer flushed with messages remaining", zap.Int("remaining", remaining))
	}
	p.p.Close()
}

func joinBrokers(brokers []string) string {
	result := ""
	for i, b := range brokers {
		if i > 0 {
			result += ","
		}
		result += b
	}
	return result
}
