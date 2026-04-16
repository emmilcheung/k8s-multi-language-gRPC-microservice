package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/acme/expiration-service/internal/config"
	"github.com/acme/expiration-service/internal/health"
	appkafka "github.com/acme/expiration-service/internal/kafka"
	"github.com/acme/expiration-service/internal/scheduler"
	"github.com/acme/expiration-service/internal/server"
	"github.com/acme/expiration-service/internal/tracing"
	"github.com/acme/expiration-service/internal/worker"
	"github.com/acme/expiration-service/pkg/logger"
)

func main() {
	// Load and validate config — fail loudly if anything is missing.
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: invalid configuration: %v\n", err)
		os.Exit(1)
	}

	// Initialise structured JSON logger.
	log, err := logger.New(cfg.LogLevel, "expiration-service")
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to create logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() //nolint:errcheck

	log.Info("starting expiration-service",
		zap.String("env", cfg.Env),
		zap.Int("port", cfg.Port),
	)

	// Initialise OpenTelemetry — must happen before any network I/O
	shutdownTracing := tracing.Init(context.Background(), "expiration-service", log)
	defer shutdownTracing(context.Background())

	kafkaSecurity := appkafka.SecurityConfig{
		SecurityProtocol: cfg.KafkaSecurityProtocol,
		SASLMechanism:    cfg.KafkaSASLMechanism,
		SASLUsername:     cfg.KafkaSASLUsername,
		SASLPassword:     cfg.KafkaSASLPassword,
		SSLCALocation:    cfg.KafkaSSLCALocation,
	}

	// Kafka producer — publishes expiration.order.expiration_complete events.
	producer, err := appkafka.NewProducer(cfg.KafkaBrokers, log, kafkaSecurity)
	if err != nil {
		log.Fatal("failed to create kafka producer", zap.Error(err))
	}
	defer producer.Close()

	// asynq scheduler — enqueues delayed expiration tasks into Redis.
	sched := scheduler.New(cfg.RedisAddr, log)
	defer sched.Close() //nolint:errcheck

	// asynq worker — dequeues tasks and publishes Kafka events.
	taskHandler := worker.NewHandler(producer, log)
	workerServer := worker.NewServer(cfg.RedisAddr, taskHandler, log)

	// Kafka consumer — subscribes to orders.order.created and schedules expiration tasks.
	// The producer is passed so the consumer can route failed messages to the DLQ.
	consumer, err := appkafka.NewConsumer(cfg.KafkaBrokers, "expiration-service", producer, log, kafkaSecurity)
	if err != nil {
		log.Fatal("failed to create kafka consumer", zap.Error(err))
	}
	defer consumer.Close()

	// Dependency health checkers — wired into the readiness probe.
	redisChecker := health.NewRedisChecker(cfg.RedisAddr)
	defer redisChecker.Close() //nolint:errcheck

	kafkaChecker := health.NewKafkaChecker(cfg.KafkaBrokers, kafkaSecurity)

	// Echo HTTP server — /healthz/live, /healthz/ready, /metrics.
	httpServer := server.New(redisChecker, kafkaChecker, log)

	// Start asynq worker in background.
	go func() {
		if err := workerServer.Start(); err != nil {
			log.Fatal("asynq worker error", zap.Error(err))
		}
	}()

	// Start Kafka consumer in background.
	consumerCtx, cancelConsumer := context.WithCancel(context.Background())
	go func() {
		consumer.Start(consumerCtx, func(ctx context.Context, data appkafka.OrderCreatedData) error {
			expiresAt, err := time.Parse(time.RFC3339, data.ExpiresAt)
			if err != nil {
				return fmt.Errorf("parse expiresAt %q: %w", data.ExpiresAt, err)
			}
			return sched.ScheduleExpiration(ctx, data.OrderID, expiresAt)
		})
	}()

	// Start HTTP server in background.
	go func() {
		if err := httpServer.Start(cfg.Port); err != nil {
			log.Error("HTTP server stopped", zap.Error(err))
		}
	}()

	// Wait for termination signal.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info("shutting down expiration-service")

	// Stop components in reverse order.
	cancelConsumer()

	workerServer.Shutdown()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Error("HTTP server shutdown error", zap.Error(err))
	}
}
