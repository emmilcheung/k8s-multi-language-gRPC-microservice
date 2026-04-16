package config_test

import (
	"os"
	"testing"

	"github.com/acme/venue-service/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_ShouldReturnError_WhenDatabaseURLMissing(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")

	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "DATABASE_URL is required")
}

func TestLoad_ShouldReturnError_WhenKafkaBrokersMissing(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/venue_db")
	t.Setenv("KAFKA_BROKERS", "")

	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_BROKERS is required")
}

func TestLoad_ShouldReturnError_WhenPortInvalid(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/venue_db")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("PORT", "not-a-port")

	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "PORT")
}

func TestLoad_ShouldSucceed_WhenAllRequiredEnvVarsSet(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/venue_db")
	t.Setenv("KAFKA_BROKERS", "localhost:9092,localhost:9093")
	t.Setenv("PORT", "3003")
	t.Setenv("GRPC_PORT", "50052")
	t.Setenv("APP_ENV", "test")
	t.Setenv("LOG_LEVEL", "debug")
	t.Setenv("REDIS_URL", "redis://localhost:6379")
	t.Setenv("TICKET_SERVICE_URL", "localhost:50051")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "test", cfg.Env)
	assert.Equal(t, 3003, cfg.Port)
	assert.Equal(t, 50052, cfg.GrpcPort)
	assert.Equal(t, "debug", cfg.LogLevel)
	assert.Equal(t, []string{"localhost:9092", "localhost:9093"}, cfg.KafkaBrokers)
	assert.Equal(t, "PLAINTEXT", cfg.KafkaSecurityProtocol)
	assert.Equal(t, "redis://localhost:6379", cfg.RedisURL)
}

func TestLoad_ShouldUseDefaults_WhenOptionalEnvVarsAbsent(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/venue_db")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("TICKET_SERVICE_URL", "localhost:50051")
	require.NoError(t, os.Unsetenv("PORT"))
	require.NoError(t, os.Unsetenv("GRPC_PORT"))
	require.NoError(t, os.Unsetenv("APP_ENV"))
	require.NoError(t, os.Unsetenv("LOG_LEVEL"))
	require.NoError(t, os.Unsetenv("REDIS_URL"))

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "development", cfg.Env)
	assert.Equal(t, 3003, cfg.Port)
	assert.Equal(t, 50052, cfg.GrpcPort)
	assert.Equal(t, "info", cfg.LogLevel)
	assert.Equal(t, "", cfg.RedisURL)
}

func TestLoad_ShouldReturnError_WhenKafkaSASLCredentialsMissing(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/venue_db")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("TICKET_SERVICE_URL", "localhost:50051")
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
	t.Setenv("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256")

	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_SASL_USERNAME")
	assert.Contains(t, err.Error(), "KAFKA_SASL_PASSWORD")
}

func TestLoad_ShouldLoadKafkaSASLConfig(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/venue_db")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("TICKET_SERVICE_URL", "localhost:50051")
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
	t.Setenv("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256")
	t.Setenv("KAFKA_SASL_USERNAME", "venue-service")
	t.Setenv("KAFKA_SASL_PASSWORD", "secret")
	t.Setenv("KAFKA_SSL_CA_LOCATION", "/etc/ssl/certs/ca.pem")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "SASL_SSL", cfg.KafkaSecurityProtocol)
	assert.Equal(t, "SCRAM-SHA-256", cfg.KafkaSASLMechanism)
	assert.Equal(t, "venue-service", cfg.KafkaSASLUsername)
	assert.Equal(t, "secret", cfg.KafkaSASLPassword)
	assert.Equal(t, "/etc/ssl/certs/ca.pem", cfg.KafkaSSLCALocation)
}
