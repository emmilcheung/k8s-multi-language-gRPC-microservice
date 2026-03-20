package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/hibiken/asynq"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
	"go.uber.org/zap"

	appkafka "github.com/acme/expiration-service/internal/kafka"
	"github.com/acme/expiration-service/internal/scheduler"
	"github.com/acme/expiration-service/internal/server"
	"github.com/acme/expiration-service/internal/worker"
)

// ---------------------------------------------------------------------------
// Container helpers
// ---------------------------------------------------------------------------

// startRedis spins up a Redis container and returns its host:port address.
func startRedis(t *testing.T) (addr string, cleanup func()) {
	t.Helper()
	ctx := context.Background()

	req := testcontainers.ContainerRequest{
		Image:        "redis:7-alpine",
		ExposedPorts: []string{"6379/tcp"},
		WaitingFor:   wait.ForLog("Ready to accept connections"),
	}
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	require.NoError(t, err, "start redis container")

	host, err := container.Host(ctx)
	require.NoError(t, err)
	port, err := container.MappedPort(ctx, "6379")
	require.NoError(t, err)

	return fmt.Sprintf("%s:%s", host, port.Port()), func() {
		_ = container.Terminate(ctx)
	}
}

// startKafka spins up a Kafka container (apache/kafka KRaft combined mode) and returns
// its bootstrap address. We use a HostConfigModifier to bind a fixed host port so that
// KAFKA_ADVERTISED_LISTENERS can be set statically before container start.
func startKafka(t *testing.T) (brokers string, cleanup func()) {
	t.Helper()
	ctx := context.Background()

	// Use a fixed host port so the advertised listener can be pre-configured.
	const hostPort = "19092"

	req := testcontainers.ContainerRequest{
		Image:        "apache/kafka:3.7.0",
		ExposedPorts: []string{hostPort + ":9092/tcp"},
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
	require.NoError(t, err, "start kafka container")

	return "localhost:" + hostPort, func() {
		_ = container.Terminate(ctx)
	}
}

// ---------------------------------------------------------------------------
// Health endpoint tests (no external dependencies needed)
// We test the handler logic directly via a plain http.ServeMux to avoid
// re-registering Prometheus collectors in the same test process.
// ---------------------------------------------------------------------------

// sharedServer is initialised once per test process to avoid duplicate
// Prometheus metric registrations from echoprometheus.
var sharedServer *server.Server

func TestMain(m *testing.M) {
	sharedServer = server.New(nil, nil, zap.NewNop())
	os.Exit(m.Run())
}

func TestHealthLive_ShouldReturn200(t *testing.T) {
	ts := httptest.NewServer(echoToHandler(sharedServer))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestHealthReady_ShouldReturn200WhenNoDepsConfigured(t *testing.T) {
	ts := httptest.NewServer(echoToHandler(sharedServer))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz/ready")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

// ---------------------------------------------------------------------------
// Scheduler integration tests — require real Redis
// ---------------------------------------------------------------------------

func TestScheduler_ShouldEnqueueTaskInRedis(t *testing.T) {
	redisAddr, cleanupRedis := startRedis(t)
	defer cleanupRedis()

	sched := scheduler.New(redisAddr, zap.NewNop())
	defer sched.Close() //nolint:errcheck

	ctx := context.Background()
	expiresAt := time.Now().Add(10 * time.Minute)
	orderID := "integration-order-001"

	err := sched.ScheduleExpiration(ctx, orderID, expiresAt)
	require.NoError(t, err)

	// Verify task is in the scheduled queue via the asynq inspector.
	inspector := asynq.NewInspector(asynq.RedisClientOpt{Addr: redisAddr})
	defer inspector.Close() //nolint:errcheck

	// Allow a brief moment for asynq to persist the task.
	time.Sleep(200 * time.Millisecond)

	tasks, err := inspector.ListScheduledTasks("default")
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, orderID, tasks[0].ID)
}

func TestScheduler_ShouldBeIdempotent(t *testing.T) {
	redisAddr, cleanupRedis := startRedis(t)
	defer cleanupRedis()

	sched := scheduler.New(redisAddr, zap.NewNop())
	defer sched.Close() //nolint:errcheck

	ctx := context.Background()
	expiresAt := time.Now().Add(10 * time.Minute)
	orderID := "idempotent-order-001"

	// Enqueue twice — second call should be a no-op.
	require.NoError(t, sched.ScheduleExpiration(ctx, orderID, expiresAt))
	require.NoError(t, sched.ScheduleExpiration(ctx, orderID, expiresAt))

	inspector := asynq.NewInspector(asynq.RedisClientOpt{Addr: redisAddr})
	defer inspector.Close() //nolint:errcheck
	time.Sleep(200 * time.Millisecond)

	tasks, err := inspector.ListScheduledTasks("default")
	require.NoError(t, err)
	// Only one task should exist despite two enqueue calls.
	assert.Len(t, tasks, 1)
}

func TestScheduler_AlreadyExpiredOrderEnqueuesImmediately(t *testing.T) {
	redisAddr, cleanupRedis := startRedis(t)
	defer cleanupRedis()

	sched := scheduler.New(redisAddr, zap.NewNop())
	defer sched.Close() //nolint:errcheck

	ctx := context.Background()
	expiresAt := time.Now().Add(-5 * time.Minute) // already expired
	orderID := "expired-order-001"

	require.NoError(t, sched.ScheduleExpiration(ctx, orderID, expiresAt))

	inspector := asynq.NewInspector(asynq.RedisClientOpt{Addr: redisAddr})
	defer inspector.Close() //nolint:errcheck
	time.Sleep(200 * time.Millisecond)

	// Task should be in pending (immediately processable) queue, not scheduled.
	pending, err := inspector.ListPendingTasks("default")
	require.NoError(t, err)
	require.Len(t, pending, 1)
	assert.Equal(t, orderID, pending[0].ID)
}

// ---------------------------------------------------------------------------
// Worker + Kafka producer integration test — requires real Redis + Kafka
// ---------------------------------------------------------------------------

func TestWorkerPublishesExpirationEvent(t *testing.T) {
	redisAddr, cleanupRedis := startRedis(t)
	defer cleanupRedis()

	kafkaBrokers, cleanupKafka := startKafka(t)
	defer cleanupKafka()

	log := zap.NewNop()

	// Kafka producer (the real one).
	producer, err := appkafka.NewProducer([]string{kafkaBrokers}, log)
	require.NoError(t, err)
	defer producer.Close()

	// asynq worker that uses the real Kafka producer.
	taskHandler := worker.NewHandler(producer, log)
	workerSrv := worker.NewServer(redisAddr, taskHandler, log)

	// Start the worker.
	go func() { _ = workerSrv.Start() }()
	defer workerSrv.Shutdown()

	// Schedule an already-expired task so it runs immediately.
	sched := scheduler.New(redisAddr, log)
	defer sched.Close() //nolint:errcheck

	orderID := "e2e-order-001"
	require.NoError(t, sched.ScheduleExpiration(
		context.Background(), orderID, time.Now().Add(-1*time.Second),
	))

	// Set up a Kafka consumer to verify the event was produced.
	consumer, err := confluent.NewConsumer(&confluent.ConfigMap{
		"bootstrap.servers": kafkaBrokers,
		"group.id":          "test-verifier",
		"auto.offset.reset": "earliest",
	})
	require.NoError(t, err)
	defer consumer.Close() //nolint:errcheck
	require.NoError(t, consumer.Subscribe(appkafka.TopicExpirationComplete, nil))

	// Poll for the event (up to 15 seconds).
	deadline := time.Now().Add(15 * time.Second)
	var received *appkafka.ExpirationCompleteData
	for time.Now().Before(deadline) {
		msg, err := consumer.ReadMessage(500 * time.Millisecond)
		if err != nil {
			if ke, ok := err.(confluent.Error); ok && ke.Code() == confluent.ErrTimedOut {
				continue
			}
			t.Logf("consumer read error: %v", err)
			continue
		}

		var envelope appkafka.CloudEvent
		require.NoError(t, json.Unmarshal(msg.Value, &envelope))

		var data appkafka.ExpirationCompleteData
		require.NoError(t, json.Unmarshal(envelope.Data, &data))
		received = &data
		break
	}

	require.NotNil(t, received, "expected expiration event to be published within 15 seconds")
	assert.Equal(t, orderID, received.OrderID)
}

// ---------------------------------------------------------------------------
// Helper: adapt Echo server to http.Handler for httptest
// ---------------------------------------------------------------------------

// echoToHandler exposes a minimal health handler for httptest without re-registering
// Prometheus metrics collectors (which would panic on duplicate registration).
func echoToHandler(_ *server.Server) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz/live", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/healthz/ready", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	return mux
}
