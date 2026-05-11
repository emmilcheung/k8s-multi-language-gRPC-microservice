package kafka

import (
	"fmt"
	"strings"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.uber.org/zap"
)

// TopicOrderCompleted is the topic where order-service emits completed orders.
const TopicOrderCompleted = "orders.order.completed"

// TopicOrderCompletedDLQ is the dead-letter topic for failed order.completed messages.
const TopicOrderCompletedDLQ = "orders.order.completed.dlq"

// TopicAttendanceQRIssued is the topic where attendance-service emits issued QR credential events.
const TopicAttendanceQRIssued = "attendance.qr.issued"

// Producer wraps the Confluent Kafka producer with structured event publishing.
type Producer struct {
	p   *confluent.Producer
	log *zap.Logger
}

// NewProducer creates a Kafka producer with idempotence and acks=all.
func NewProducer(brokers []string, log *zap.Logger, security ...SecurityConfig) (*Producer, error) {
	configMap := &confluent.ConfigMap{
		"bootstrap.servers":  strings.Join(brokers, ","),
		"acks":               "all",
		"enable.idempotence": true,
	}
	sec := SecurityConfig{SecurityProtocol: "PLAINTEXT"}
	if len(security) > 0 {
		sec = security[0]
	}
	if err := sec.Apply(configMap); err != nil {
		return nil, fmt.Errorf("configure kafka producer security: %w", err)
	}
	p, err := confluent.NewProducer(configMap)
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

// Publish sends a raw message to the given topic.
func (p *Producer) Publish(topic string, key, value []byte) error {
	deliveryChan := make(chan confluent.Event, 1)
	err := p.p.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &topic, Partition: confluent.PartitionAny},
		Key:            key,
		Value:          value,
		Timestamp:      time.Now(),
	}, deliveryChan)
	if err != nil {
		return fmt.Errorf("kafka produce enqueue: %w", err)
	}

	e := <-deliveryChan
	msg, ok := e.(*confluent.Message)
	if !ok {
		return fmt.Errorf("kafka produce: unexpected event type %T", e)
	}
	if msg.TopicPartition.Error != nil {
		return fmt.Errorf("kafka produce delivery: %w", msg.TopicPartition.Error)
	}
	return nil
}
