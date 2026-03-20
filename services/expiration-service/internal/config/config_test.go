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
}

func TestLoad_MissingRedisAddr(t *testing.T) {
	os.Unsetenv("REDIS_ADDR")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "REDIS_ADDR")
}

func TestLoad_MissingKafkaBrokers(t *testing.T) {
	t.Setenv("REDIS_ADDR", "localhost:6379")
	os.Unsetenv("KAFKA_BROKERS")

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
	os.Unsetenv("PORT")
	os.Unsetenv("APP_ENV")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, 8080, cfg.Port)
	assert.Equal(t, "development", cfg.Env)
}

func TestLoad_MissingBothRequiredFields(t *testing.T) {
	os.Unsetenv("REDIS_ADDR")
	os.Unsetenv("KAFKA_BROKERS")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "REDIS_ADDR")
	assert.Contains(t, err.Error(), "KAFKA_BROKERS")
}
