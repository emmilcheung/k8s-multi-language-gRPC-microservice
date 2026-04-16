package health

import (
	"context"
	"fmt"
	"strings"

	appkafka "github.com/acme/venue-service/internal/kafka"
	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// DBChecker verifies PostgreSQL connectivity.
type DBChecker struct {
	pool *pgxpool.Pool
}

func NewDBChecker(pool *pgxpool.Pool) *DBChecker {
	return &DBChecker{pool: pool}
}

func (d *DBChecker) Ping(ctx context.Context) error {
	if err := d.pool.Ping(ctx); err != nil {
		return fmt.Errorf("postgres ping: %w", err)
	}
	return nil
}

// RedisChecker verifies Redis connectivity.
type RedisChecker struct {
	client *redis.Client
}

func NewRedisChecker(redisURL string) (*RedisChecker, error) {
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	return &RedisChecker{client: redis.NewClient(options)}, nil
}

func (r *RedisChecker) Ping(ctx context.Context) error {
	if err := r.client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis ping: %w", err)
	}
	return nil
}

func (r *RedisChecker) Close() error {
	return r.client.Close()
}

// KafkaChecker verifies Kafka connectivity via metadata fetch.
type KafkaChecker struct {
	brokers  string
	security appkafka.SecurityConfig
}

func NewKafkaChecker(brokers []string, security ...appkafka.SecurityConfig) *KafkaChecker {
	checker := &KafkaChecker{
		brokers:  strings.Join(brokers, ","),
		security: appkafka.SecurityConfig{SecurityProtocol: "PLAINTEXT"},
	}
	if len(security) > 0 {
		checker.security = security[0]
	}
	return checker
}

func (k *KafkaChecker) Ping(_ context.Context) error {
	configMap := &kafka.ConfigMap{
		"bootstrap.servers":           k.brokers,
		"socket.timeout.ms":           1000,
		"request.timeout.ms":          1000,
		"metadata.request.timeout.ms": 1000,
	}
	if err := k.security.Apply(configMap); err != nil {
		return fmt.Errorf("configure kafka admin client security: %w", err)
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
