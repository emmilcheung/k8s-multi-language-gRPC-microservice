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

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "test", cfg.Env)
	assert.Equal(t, 3003, cfg.Port)
	assert.Equal(t, 50052, cfg.GrpcPort)
	assert.Equal(t, "debug", cfg.LogLevel)
	assert.Equal(t, []string{"localhost:9092", "localhost:9093"}, cfg.KafkaBrokers)
	assert.Equal(t, "redis://localhost:6379", cfg.RedisURL)
}

func TestLoad_ShouldUseDefaults_WhenOptionalEnvVarsAbsent(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/venue_db")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	os.Unsetenv("PORT")
	os.Unsetenv("GRPC_PORT")
	os.Unsetenv("APP_ENV")
	os.Unsetenv("LOG_LEVEL")
	os.Unsetenv("REDIS_URL")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "development", cfg.Env)
	assert.Equal(t, 3003, cfg.Port)
	assert.Equal(t, 50052, cfg.GrpcPort)
	assert.Equal(t, "info", cfg.LogLevel)
	assert.Equal(t, "", cfg.RedisURL)
}
