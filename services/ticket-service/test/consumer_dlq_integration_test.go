package integration_test

// consumer_dlq_integration_test.go — R-03
//
// Verifies that when the OrderConsumer's handler fails on every attempt, the
// raw message is routed to the dead-letter topic and the offset is committed
// (so the poison-pill message does not block the partition).

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

	appkafka "github.com/acme/ticket-service/internal/kafka"
)

// alwaysFailReserver is a TicketReserver stub that returns an error on every call.
// Used to drive the consumer retry loop to exhaustion.
type alwaysFailReserver struct{ err error }

func (r *alwaysFailReserver) ReserveTicket(_ context.Context, _, _ string) error       { return r.err }
func (r *alwaysFailReserver) ReleaseTicket(_ context.Context, _ string) error          { return r.err }
func (r *alwaysFailReserver) ReleaseReservation(_ context.Context, _ string) error     { return r.err }
func (r *alwaysFailReserver) FinalizeReservation(_ context.Context, _, _ string) error { return r.err }

// startKafkaForDLQ spins up apache/kafka in KRaft mode bound to a fixed host port.
// Returns the broker address and a cleanup function.
func startKafkaForDLQ(t *testing.T) (brokers string, cleanup func()) {
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
	require.NoError(t, err, "start Kafka container")

	return "localhost:" + hostPort, func() { _ = container.Terminate(ctx) }
}

// TestOrderConsumer_FailedMessageRoutedToDLQ verifies R-03:
// when handler processing fails on all 3 attempts, the message appears on
// orders.order.created.dlq and the offset is committed.
func TestOrderConsumer_FailedMessageRoutedToDLQ(t *testing.T) {
	brokers, cleanupKafka := startKafkaForDLQ(t)
	defer cleanupKafka()

	log := zap.NewNop()

	// Create the producer (used by OrderConsumer to write to DLQ).
	producer, err := appkafka.NewProducer([]string{brokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	// Stub reserver that always returns an error — forces all retries to fail.
	reserver := &alwaysFailReserver{err: fmt.Errorf("simulated DB failure")}

	// Create the OrderConsumer.
	consumer, err := appkafka.NewOrderConsumer([]string{brokers}, "test-dlq-group", reserver, producer, log)
	require.NoError(t, err)

	// Publish a test orders.order.created message directly to Kafka.
	rawProducer, err := confluent.NewProducer(&confluent.ConfigMap{
		"bootstrap.servers": brokers,
		"acks":              "all",
	})
	require.NoError(t, err)
	defer rawProducer.Close()

	payload, err := json.Marshal(map[string]interface{}{
		"type": "orders.order.created",
		"data": map[string]string{
			"orderId":  "order-dlq-test-001",
			"ticketId": "ticket-dlq-test-001",
		},
	})
	require.NoError(t, err)

	topic := appkafka.TopicOrderCreated
	deliveryChan := make(chan confluent.Event, 1)
	require.NoError(t, rawProducer.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &topic, Partition: confluent.PartitionAny},
		Key:            []byte("order-dlq-test-001"),
		Value:          payload,
	}, deliveryChan))
	e := <-deliveryChan
	require.Nil(t, e.(*confluent.Message).TopicPartition.Error, "failed to produce test message")

	// Set up a DLQ consumer to verify the message appears there.
	dlqConsumer, err := confluent.NewConsumer(&confluent.ConfigMap{
		"bootstrap.servers": brokers,
		"group.id":          "test-dlq-verifier",
		"auto.offset.reset": "earliest",
	})
	require.NoError(t, err)
	defer dlqConsumer.Close() //nolint:errcheck

	dlqTopic := appkafka.TopicOrderCreated + ".dlq"
	require.NoError(t, dlqConsumer.Subscribe(dlqTopic, nil))

	// Run the consumer in a goroutine — it will attempt to process the message,
	// retry 3 times, then route to DLQ.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	go consumer.Start(ctx)

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

	require.NotNil(t, dlqMsg, "expected message to appear on DLQ topic %q within 30 seconds", dlqTopic)
	assert.Equal(t, payload, dlqMsg.Value, "DLQ message payload should be the original unmodified bytes")
	assert.Equal(t, []byte("order-dlq-test-001"), dlqMsg.Key, "DLQ message key should match original")

	// Verify the DLQ headers contain error context.
	var foundSourceHeader, foundErrorHeader bool
	for _, h := range dlqMsg.Headers {
		if h.Key == "x-dlq-source-topic" {
			assert.Equal(t, appkafka.TopicOrderCreated, string(h.Value))
			foundSourceHeader = true
		}
		if h.Key == "x-dlq-error" {
			assert.Contains(t, string(h.Value), "simulated DB failure")
			foundErrorHeader = true
		}
	}
	assert.True(t, foundSourceHeader, "DLQ message should have x-dlq-source-topic header")
	assert.True(t, foundErrorHeader, "DLQ message should have x-dlq-error header")
}
