package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_ValidConfig(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("PORT", "8080")
	t.Setenv("APP_ENV", "test")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "test", cfg.Env)
	assert.Equal(t, 8080, cfg.Port)
	assert.Equal(t, "localhost:6379", cfg.RedisAddr)
	assert.Equal(t, []string{"localhost:9092"}, cfg.KafkaBrokers)
	assert.Equal(t, "PLAINTEXT", cfg.KafkaSecurityProtocol)
}

func TestLoad_MissingRedisAddr(t *testing.T) {
	require.NoError(t, os.Unsetenv("REDIS_ADDR"))
	t.Setenv("KAFKA_BROKERS", "localhost:9092")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "REDIS_ADDR")
}

func TestLoad_MissingKafkaBrokers(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	require.NoError(t, os.Unsetenv("KAFKA_BROKERS"))

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_BROKERS")
}

func TestLoad_InvalidPort(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("PORT", "not-a-port")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "PORT")
}

func TestLoad_MultipleBrokers(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	t.Setenv("KAFKA_BROKERS", "broker1:9092, broker2:9092, broker3:9092")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Len(t, cfg.KafkaBrokers, 3)
	assert.Equal(t, "broker1:9092", cfg.KafkaBrokers[0])
}

func TestLoad_Defaults(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	require.NoError(t, os.Unsetenv("PORT"))
	require.NoError(t, os.Unsetenv("APP_ENV"))

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, 8080, cfg.Port)
	assert.Equal(t, "development", cfg.Env)
}

func TestLoad_MissingBothRequiredFields(t *testing.T) {
	require.NoError(t, os.Unsetenv("REDIS_ADDR"))
	require.NoError(t, os.Unsetenv("KAFKA_BROKERS"))

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "REDIS_ADDR")
	assert.Contains(t, err.Error(), "KAFKA_BROKERS")
}

func TestLoad_KafkaSASLRequiresCredentials(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
	t.Setenv("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_SASL_USERNAME")
	assert.Contains(t, err.Error(), "KAFKA_SASL_PASSWORD")
}

func TestLoad_KafkaSASLConfig(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
	t.Setenv("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256")
	t.Setenv("KAFKA_SASL_USERNAME", "expiration-service")
	t.Setenv("KAFKA_SASL_PASSWORD", "secret")
	t.Setenv("KAFKA_SSL_CA_LOCATION", "/etc/ssl/certs/ca.pem")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "SASL_SSL", cfg.KafkaSecurityProtocol)
	assert.Equal(t, "SCRAM-SHA-256", cfg.KafkaSASLMechanism)
	assert.Equal(t, "expiration-service", cfg.KafkaSASLUsername)
	assert.Equal(t, "secret", cfg.KafkaSASLPassword)
	assert.Equal(t, "/etc/ssl/certs/ca.pem", cfg.KafkaSSLCALocation)
}
