// Package health provides dependency readiness checkers for the expiration-service.
// Each checker implements server.DependencyChecker (a Ping(ctx) error interface).
package health

import (
	"context"
	"fmt"
	"time"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
	redis "github.com/redis/go-redis/v9"
)

// ── Redis checker ─────────────────────────────────────────────────────────────

// RedisChecker pings the Redis server to verify connectivity.
type RedisChecker struct {
	client *redis.Client
}

// NewRedisChecker creates a RedisChecker from a Redis address string (host:port).
func NewRedisChecker(addr string) *RedisChecker {
	rdb := redis.NewClient(&redis.Options{
		Addr:         addr,
		DialTimeout:  1 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
	})
	return &RedisChecker{client: rdb}
}

// Ping issues a Redis PING and returns an error if the server does not respond.
func (r *RedisChecker) Ping(ctx context.Context) error {
	if err := r.client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis ping: %w", err)
	}
	return nil
}

// Close releases the Redis client connection pool.
func (r *RedisChecker) Close() error {
	return r.client.Close()
}

// ── Kafka checker ─────────────────────────────────────────────────────────────

// KafkaChecker verifies Kafka connectivity by fetching cluster metadata.
type KafkaChecker struct {
	brokers string
}

// NewKafkaChecker creates a KafkaChecker for the given broker list.
func NewKafkaChecker(brokers []string) *KafkaChecker {
	result := ""
	for i, b := range brokers {
		if i > 0 {
			result += ","
		}
		result += b
	}
	return &KafkaChecker{brokers: result}
}

// Ping creates a temporary admin client and fetches cluster metadata.
// Returns an error if the broker cannot be reached within 1 second.
func (k *KafkaChecker) Ping(ctx context.Context) error {
	// Create a short-lived admin client for metadata fetch
	admin, err := confluent.NewAdminClient(&confluent.ConfigMap{
		"bootstrap.servers":           k.brokers,
		"socket.timeout.ms":           1000,
		"request.timeout.ms":          1000,
		"metadata.request.timeout.ms": 1000,
	})
	if err != nil {
		return fmt.Errorf("kafka admin client: %w", err)
	}
	defer admin.Close()

	_, err = admin.GetMetadata(nil, false, 1000)
	if err != nil {
		return fmt.Errorf("kafka metadata fetch: %w", err)
	}
	return nil
}
