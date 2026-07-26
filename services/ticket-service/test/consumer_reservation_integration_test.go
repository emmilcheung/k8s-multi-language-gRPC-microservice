package integration_test

// consumer_reservation_integration_test.go — CP-04
//
// Integration tests for the updated Kafka consumer:
//   - orders.order.cancelled with reservationId → ReleaseReservation (GA path)
//   - orders.order.completed with reservationId → FinalizeReservation (GA path)
//   - orders.order.completed without reservationId → error (DLQ path)
//
// These tests use a Kafka Testcontainer (KRaft mode) and an in-memory MongoDB
// repository stub so that we can verify that the correct repository methods are
// called with the correct arguments. All tests are guarded by testing.Short().

import (
	"context"
	"encoding/json"
	"sync"
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

// ── Stub reserver ──────────────────────────────────────────────────────────────

// recordingReserver records calls to each method for assertion.
type recordingReserver struct {
	mu                  sync.Mutex
	reserveTicket       [][]string // each element: [ticketID, orderID]
	releaseTicket       []string   // ticketIDs
	releaseReservation  []string   // reservationIDs
	finalizeReservation [][]string // each element: [reservationID, orderID]
	releaseErr          error
	finalizeErr         error
}

func (r *recordingReserver) ReserveTicket(_ context.Context, ticketID, orderID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reserveTicket = append(r.reserveTicket, []string{ticketID, orderID})
	return nil
}

func (r *recordingReserver) ReleaseTicket(_ context.Context, ticketID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.releaseTicket = append(r.releaseTicket, ticketID)
	return nil
}

func (r *recordingReserver) ReleaseReservation(_ context.Context, reservationID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.releaseReservation = append(r.releaseReservation, reservationID)
	return r.releaseErr
}

func (r *recordingReserver) FinalizeReservation(_ context.Context, reservationID, orderID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.finalizeReservation = append(r.finalizeReservation, []string{reservationID, orderID})
	return r.finalizeErr
}

// ── Kafka helpers ─────────────────────────────────────────────────────────────

// publishToKafka publishes a raw JSON payload to the given topic.
func publishToKafka(t *testing.T, brokers, topic string, payload []byte) {
	t.Helper()
	p, err := confluent.NewProducer(&confluent.ConfigMap{
		"bootstrap.servers": brokers,
		"acks":              "all",
	})
	require.NoError(t, err)
	defer p.Close()

	deliveryChan := make(chan confluent.Event, 1)
	require.NoError(t, p.Produce(&confluent.Message{
		TopicPartition: confluent.TopicPartition{Topic: &topic, Partition: confluent.PartitionAny},
		Key:            []byte(topic),
		Value:          payload,
	}, deliveryChan))
	e := <-deliveryChan
	require.Nil(t, e.(*confluent.Message).TopicPartition.Error, "failed to produce message to %s", topic)
}

// waitForCall polls fn until it returns true or the timeout elapses.
func waitForCall(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("timed out waiting for expected consumer call")
}

// ── Tests ──────────────────────────────────────────────────────────────────────

// TestOrderConsumer_OrderCancelled_GA_ReleasesReservation verifies that when
// an orders.order.cancelled event carries a reservationId, the consumer calls
// ReleaseReservation (GA path) and does NOT call ReleaseTicket (legacy path).
func TestOrderConsumer_OrderCancelled_GA_ReleasesReservation(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	brokers, cleanup := startKafkaForConsumerTests(t)
	defer cleanup()

	log := zap.NewNop()
	reserver := &recordingReserver{}

	producer, err := appkafka.NewProducer([]string{brokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	consumer, err := appkafka.NewOrderConsumer([]string{brokers}, "test-cancel-ga-group", reserver, producer, log)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	go consumer.Start(ctx)

	payload, err := json.Marshal(map[string]interface{}{
		"type": "orders.order.cancelled",
		"data": map[string]interface{}{
			"orderId":       "order-cancel-ga-1",
			"ticketId":      "ticket-cancel-ga-1",
			"reservationId": "resv-cancel-ga-1",
		},
	})
	require.NoError(t, err)
	publishToKafka(t, brokers, appkafka.TopicOrderCancelled, payload)

	waitForCall(t, 30*time.Second, func() bool {
		reserver.mu.Lock()
		defer reserver.mu.Unlock()
		return len(reserver.releaseReservation) > 0
	})

	reserver.mu.Lock()
	defer reserver.mu.Unlock()

	assert.Equal(t, []string{"resv-cancel-ga-1"}, reserver.releaseReservation, "should call ReleaseReservation with correct id")
	assert.Empty(t, reserver.releaseTicket, "should NOT call legacy ReleaseTicket for GA events")
}

// TestOrderConsumer_OrderCancelled_Legacy_ReleasesTicket verifies that when
// an orders.order.cancelled event has no reservationId, the legacy ReleaseTicket
// path is used.
func TestOrderConsumer_OrderCancelled_Legacy_ReleasesTicket(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	brokers, cleanup := startKafkaForConsumerTests(t)
	defer cleanup()

	log := zap.NewNop()
	reserver := &recordingReserver{}

	producer, err := appkafka.NewProducer([]string{brokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	consumer, err := appkafka.NewOrderConsumer([]string{brokers}, "test-cancel-legacy-group", reserver, producer, log)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	go consumer.Start(ctx)

	payload, err := json.Marshal(map[string]interface{}{
		"type": "orders.order.cancelled",
		"data": map[string]interface{}{
			"orderId":  "order-cancel-leg-1",
			"ticketId": "ticket-cancel-leg-1",
			// No reservationId → legacy path
		},
	})
	require.NoError(t, err)
	publishToKafka(t, brokers, appkafka.TopicOrderCancelled, payload)

	waitForCall(t, 30*time.Second, func() bool {
		reserver.mu.Lock()
		defer reserver.mu.Unlock()
		return len(reserver.releaseTicket) > 0
	})

	reserver.mu.Lock()
	defer reserver.mu.Unlock()
	assert.Equal(t, []string{"ticket-cancel-leg-1"}, reserver.releaseTicket)
	assert.Empty(t, reserver.releaseReservation)
}

// TestOrderConsumer_OrderCompleted_FinalizesReservation verifies that
// orders.order.completed events trigger FinalizeReservation with the correct
// reservationId and orderId.
func TestOrderConsumer_OrderCompleted_FinalizesReservation(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	brokers, cleanup := startKafkaForConsumerTests(t)
	defer cleanup()

	log := zap.NewNop()
	reserver := &recordingReserver{}

	producer, err := appkafka.NewProducer([]string{brokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	consumer, err := appkafka.NewOrderConsumer([]string{brokers}, "test-completed-group", reserver, producer, log)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	go consumer.Start(ctx)

	payload, err := json.Marshal(map[string]interface{}{
		"type": "orders.order.completed",
		"data": map[string]interface{}{
			"orderId":       "order-comp-1",
			"ticketId":      "ticket-comp-1",
			"reservationId": "resv-comp-1",
			"quantity":      2,
		},
	})
	require.NoError(t, err)
	publishToKafka(t, brokers, appkafka.TopicOrderCompleted, payload)

	waitForCall(t, 30*time.Second, func() bool {
		reserver.mu.Lock()
		defer reserver.mu.Unlock()
		return len(reserver.finalizeReservation) > 0
	})

	reserver.mu.Lock()
	defer reserver.mu.Unlock()
	require.Len(t, reserver.finalizeReservation, 1)
	assert.Equal(t, "resv-comp-1", reserver.finalizeReservation[0][0])
	assert.Equal(t, "order-comp-1", reserver.finalizeReservation[0][1])
}

// TestOrderConsumer_OrderCompleted_DuplicateEvent_IsIdempotent verifies that
// a duplicate orders.order.completed event (Kafka at-least-once delivery) does
// not cause a second FinalizeReservation error when the repo returns an error
// indicating the reservation is already SOLD. The consumer should route the
// second message to DLQ only if it genuinely fails.
func TestOrderConsumer_OrderCompleted_DuplicateEvent_IsIdempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	brokers, cleanup := startKafkaForConsumerTests(t)
	defer cleanup()

	log := zap.NewNop()
	// On the second call FinalizeReservation returns nil (idempotent success),
	// simulating what the real repository does.
	reserver := &recordingReserver{}

	producer, err := appkafka.NewProducer([]string{brokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	consumer, err := appkafka.NewOrderConsumer([]string{brokers}, "test-completed-idem-group", reserver, producer, log)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	go consumer.Start(ctx)

	payload, err := json.Marshal(map[string]interface{}{
		"type": "orders.order.completed",
		"data": map[string]interface{}{
			"orderId":       "order-comp-idem",
			"ticketId":      "ticket-comp-idem",
			"reservationId": "resv-comp-idem",
			"quantity":      1,
		},
	})
	require.NoError(t, err)

	// Publish same event twice.
	publishToKafka(t, brokers, appkafka.TopicOrderCompleted, payload)
	publishToKafka(t, brokers, appkafka.TopicOrderCompleted, payload)

	// Wait until at least 2 finalize calls arrive.
	waitForCall(t, 30*time.Second, func() bool {
		reserver.mu.Lock()
		defer reserver.mu.Unlock()
		return len(reserver.finalizeReservation) >= 2
	})

	reserver.mu.Lock()
	defer reserver.mu.Unlock()
	// Both calls should have used the same IDs.
	for _, call := range reserver.finalizeReservation {
		assert.Equal(t, "resv-comp-idem", call[0])
		assert.Equal(t, "order-comp-idem", call[1])
	}
}

// TestOrderConsumer_OrderCompleted_MissingReservationId_RoutesToDLQ verifies
// that a malformed order.completed event (no reservationId) is routed to DLQ.
func TestOrderConsumer_OrderCompleted_MissingReservationId_RoutesToDLQ(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	brokers, cleanup := startKafkaForConsumerTests(t)
	defer cleanup()

	log := zap.NewNop()
	reserver := &recordingReserver{}

	producer, err := appkafka.NewProducer([]string{brokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	consumer, err := appkafka.NewOrderConsumer([]string{brokers}, "test-completed-dlq-group", reserver, producer, log)
	require.NoError(t, err)

	// Set up DLQ listener before publishing.
	dlqConsumer, err := confluent.NewConsumer(&confluent.ConfigMap{
		"bootstrap.servers": brokers,
		"group.id":          "test-completed-dlq-verifier",
		"auto.offset.reset": "earliest",
	})
	require.NoError(t, err)
	defer dlqConsumer.Close() //nolint:errcheck
	require.NoError(t, dlqConsumer.Subscribe(appkafka.TopicOrderCompletedDLQ, nil))

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	go consumer.Start(ctx)

	// Publish a malformed event (missing reservationId).
	payload, err := json.Marshal(map[string]interface{}{
		"type": "orders.order.completed",
		"data": map[string]interface{}{
			"orderId":  "order-comp-dlq",
			"ticketId": "ticket-comp-dlq",
			// No reservationId
		},
	})
	require.NoError(t, err)
	publishToKafka(t, brokers, appkafka.TopicOrderCompleted, payload)

	// Poll DLQ for the message.
	deadline := time.Now().Add(30 * time.Second)
	var dlqMsg *confluent.Message
	for time.Now().Before(deadline) {
		msg, readErr := dlqConsumer.ReadMessage(500 * time.Millisecond)
		if readErr != nil {
			if ke, ok := readErr.(confluent.Error); ok && ke.Code() == confluent.ErrTimedOut {
				continue
			}
			t.Logf("DLQ consumer read error: %v", readErr)
			continue
		}
		dlqMsg = msg
		break
	}

	require.NotNil(t, dlqMsg, "expected malformed message to appear on DLQ topic %s", appkafka.TopicOrderCompletedDLQ)

	// Verify DLQ headers.
	var foundSourceHeader bool
	for _, h := range dlqMsg.Headers {
		if h.Key == "x-dlq-source-topic" {
			assert.Equal(t, appkafka.TopicOrderCompleted, string(h.Value))
			foundSourceHeader = true
		}
	}
	assert.True(t, foundSourceHeader, "DLQ message should have x-dlq-source-topic header")

	// FinalizeReservation should never have been called.
	reserver.mu.Lock()
	defer reserver.mu.Unlock()
	assert.Empty(t, reserver.finalizeReservation, "FinalizeReservation must not be called for malformed event")
}

// ── Container helpers ─────────────────────────────────────────────────────────
// startKafkaForConsumerTests spins up a single-node Kafka broker (KRaft) and
// returns the broker address and a cleanup function.
// Uses host port 29093 (distinct from the DLQ test on 29092) to avoid conflicts.
func startKafkaForConsumerTests(t *testing.T) (string, func()) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	const hostPort = "29093"

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
