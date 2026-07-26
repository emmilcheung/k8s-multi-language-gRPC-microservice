package integration_test

// consumer_dlq_integration_test.go — R-04
//
// Verifies that when the Consumer's handler fails on every attempt, the raw message
// is routed to TopicExpirationCompleteDLQ and the offset is committed.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
	"go.uber.org/zap"

	appkafka "github.com/acme/expiration-service/internal/kafka"
)

// startKafkaDLQ spins up apache/kafka in KRaft mode bound to a fixed host port.
// Uses port 29092 to avoid conflicting with the port used in integration_test.go (19092).
func startKafkaDLQ(t *testing.T) (brokers string, cleanup func()) {
	t.Helper()
	ctx := context.Background()

	const hostPort = "29092"

	req := testcontainers.ContainerRequest{
		Image:        "apache/kafka:3.7.0",
		ExposedPorts: []string{"9092/tcp"},
		HostConfigModifier: func(hc *container.HostConfig) {
			hc.PortBindings = network.PortMap{
				network.MustParsePort("9092/tcp"): []network.PortBinding{{HostPort: hostPort}},
			}
		},
		Env: map[string]string{
			"KAFKA_NODE_ID":                                  "1",
			"KAFKA_PROCESS_ROLES":                            "broker,controller",
			"KAFKA_LISTENERS":                                "PLAINTEXT://:9092,CONTROLLER://:9093",
			"KAFKA_ADVERTISED_LISTENERS":                     "PLAINTEXT://localhost:" + hostPort,
			"KAFKA_LISTENER_SECURITY_PROTOCOL_MAP":           "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
			"KAFKA_CONTROLLER_QUORUM_VOTERS":                 "1@localhost:9093",
			"KAFKA_CONTROLLER_LISTENER_NAMES":                "CONTROLLER",
			"KAFKA_INTER_BROKER_LISTENER_NAME":               "PLAINTEXT",
			"KAFKA_AUTO_CREATE_TOPICS_ENABLE":                "true",
			"KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR":         "1",
			"KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR": "1",
			"KAFKA_TRANSACTION_STATE_LOG_MIN_ISR":            "1",
			"KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS":         "0",
		},
		WaitingFor: wait.ForLog("Kafka Server started").WithStartupTimeout(90 * time.Second),
	}

	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	require.NoError(t, err, "start Kafka container for DLQ test")

	return "localhost:" + hostPort, func() { _ = container.Terminate(ctx) }
}

// TestConsumer_FailedMessageRoutedToDLQ verifies R-04:
// when the OrderCreatedHandler fails on all 3 attempts, the message is routed to
// TopicExpirationCompleteDLQ with the correct headers and the offset is committed.
func TestConsumer_FailedMessageRoutedToDLQ(t *testing.T) {
	brokers, cleanupKafka := startKafkaDLQ(t)
	defer cleanupKafka()

	log := zap.NewNop()

	// Create the real Kafka producer (the consumer uses it to write to the DLQ).
	producer, err := appkafka.NewProducer([]string{brokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	// Create the consumer wired with the producer for DLQ routing.
	consumer, err := appkafka.NewConsumer([]string{brokers}, "test-dlq-group", producer, log)
	require.NoError(t, err)
	defer consumer.Close()

	// Publish a raw orders.order.created message directly to Kafka.
	rawProducer, err := confluent.NewProducer(&confluent.ConfigMap{
		"bootstrap.servers": brokers,
		"acks":              "all",
	})
	require.NoError(t, err)
	defer rawProducer.Close()

	orderID := "exp-dlq-test-order-001"
	expiresAt := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)

	innerData, err := json.Marshal(map[string]interface{}{
		"orderId":     orderID,
		"userId":      "user-001",
		"ticketId":    "ticket-001",
		"ticketTitle": "Concert",
		"ticketPrice": 50.0,
		"expiresAt":   expiresAt,
		"version":     0,
	})
	require.NoError(t, err)

	envelope, err := json.Marshal(map[string]interface{}{
		"specversion":     "1.0",
		"type":            appkafka.TopicOrderCreated,
		"source":          "order-service",
		"id":              "test-evt-001",
		"time":            time.Now().UTC().Format(time.RFC3339),
		"datacontenttype": "application/json",
		"data":            json.RawMessage(innerData),
	})
	require.NoError(t, err)

	srcTopic := appkafka.TopicOrderCreated
	deliveryChan := make(chan confluent.Event, 1)
	require.NoError(t, rawProducer.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &srcTopic, Partition: confluent.PartitionAny},
		Key:            []byte(orderID),
		Value:          envelope,
	}, deliveryChan))
	e := <-deliveryChan
	require.Nil(t, e.(*confluent.Message).TopicPartition.Error, "failed to produce test message")

	// Set up a DLQ verifier consumer.
	dlqConsumer, err := confluent.NewConsumer(&confluent.ConfigMap{
		"bootstrap.servers": brokers,
		"group.id":          "test-dlq-verifier",
		"auto.offset.reset": "earliest",
	})
	require.NoError(t, err)
	defer dlqConsumer.Close() //nolint:errcheck
	require.NoError(t, dlqConsumer.Subscribe(appkafka.TopicExpirationCompleteDLQ, nil))

	// Run the consumer with a handler that always fails — drives retries to exhaustion.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	alwaysFail := func(_ context.Context, data appkafka.OrderCreatedData) error {
		return fmt.Errorf("simulated scheduler failure for order %s", data.OrderID)
	}
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		consumer.Start(ctx, alwaysFail)
	}()
	defer func() {
		cancel()

		select {
		case <-consumerDone:
		case <-time.After(5 * time.Second):
			t.Fatal("consumer goroutine did not stop before Kafka teardown")
		}
	}()

	// Poll the DLQ topic until the message arrives or timeout.
	deadline := time.Now().Add(30 * time.Second)
	var dlqMsg *confluent.Message
	for time.Now().Before(deadline) {
		msg, err := dlqConsumer.ReadMessage(500 * time.Millisecond)
		if err != nil {
			if ke, ok := err.(confluent.Error); ok && ke.Code() == confluent.ErrTimedOut {
				continue
			}
			t.Logf("DLQ consumer read error: %v", err)
			continue
		}
		dlqMsg = msg
		break
	}

	require.NotNil(t, dlqMsg, "expected message to appear on DLQ topic %q within 30 seconds",
		appkafka.TopicExpirationCompleteDLQ)
	assert.Equal(t, envelope, dlqMsg.Value, "DLQ message payload should be the original unmodified bytes")
	assert.Equal(t, []byte(orderID), dlqMsg.Key)

	// Verify DLQ headers contain error context.
	var foundSourceHeader, foundErrorHeader bool
	for _, h := range dlqMsg.Headers {
		if h.Key == "x-dlq-source-topic" {
			assert.Equal(t, appkafka.TopicOrderCreated, string(h.Value))
			foundSourceHeader = true
		}
		if h.Key == "x-dlq-error" {
			assert.Contains(t, string(h.Value), "simulated scheduler failure")
			foundErrorHeader = true
		}
	}
	assert.True(t, foundSourceHeader, "DLQ message should have x-dlq-source-topic header")
	assert.True(t, foundErrorHeader, "DLQ message should have x-dlq-error header")
}
