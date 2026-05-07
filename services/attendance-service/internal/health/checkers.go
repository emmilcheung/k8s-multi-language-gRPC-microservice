// Package health provides readiness checkers for attendance-service dependencies.
package health

import (
	"context"
	"fmt"
	"strings"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/jackc/pgx/v5/pgxpool"

	appkafka "github.com/acme/attendance-service/internal/kafka"
)

// DBChecker verifies PostgreSQL connectivity.
type DBChecker struct {
	pool *pgxpool.Pool
}

// NewDBChecker creates a new DBChecker.
func NewDBChecker(pool *pgxpool.Pool) *DBChecker {
	return &DBChecker{pool: pool}
}

// Ping sends a ping to PostgreSQL.
func (d *DBChecker) Ping(ctx context.Context) error {
	if err := d.pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres ping: %w", err)
	}
	return nil
}

// KafkaChecker verifies Kafka connectivity via metadata fetch.
type KafkaChecker struct {
	brokers  string
	security appkafka.SecurityConfig
}

// NewKafkaChecker creates a new KafkaChecker. An optional SecurityConfig may be
// provided to match the broker's TLS/SASL requirements; omitting it defaults to
// PLAINTEXT, mirroring the pattern used by NewProducer and NewOrderConsumer.
func NewKafkaChecker(brokers []string, security ...appkafka.SecurityConfig) *KafkaChecker {
	sec := appkafka.SecurityConfig{SecurityProtocol: "PLAINTEXT"}
	if len(security) > 0 {
		sec = security[0]
	}
	return &KafkaChecker{brokers: strings.Join(brokers, ","), security: sec}
}

// Ping fetches Kafka metadata to confirm broker reachability.
func (k *KafkaChecker) Ping(_ context.Context) error {
	configMap := &kafka.ConfigMap{
		"bootstrap.servers":           k.brokers,
		"socket.timeout.ms":           1000,
		"request.timeout.ms":          1000,
		"metadata.request.timeout.ms": 1000,
	}
	if err := k.security.Apply(configMap); err != nil {
		return fmt.Errorf("kafka admin client: %w", err)
	}
	admin, err := kafka.NewAdminClient(configMap)
	if err != nil {
		return fmt.Errorf("kafka admin client: %w", err)
	}
	defer admin.Close()

	if _, err := admin.GetMetadata(nil, false, 1000); err != nil {
		return fmt.Errorf("kafka metadata fetch: %w", err)
	}
	return nil
}
