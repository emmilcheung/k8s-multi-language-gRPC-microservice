package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoad_ValidConfig(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("PORT", "3001")
	t.Setenv("APP_ENV", "test")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "test", cfg.Env)
	assert.Equal(t, 3001, cfg.Port)
	assert.Equal(t, "mongodb://localhost:27017", cfg.MongoURI)
	assert.Equal(t, []string{"localhost:9092"}, cfg.KafkaBrokers)
	assert.Equal(t, "", cfg.RedisURL)
}

func TestLoad_MissingMongoURI(t *testing.T) {
	os.Unsetenv("MONGO_URI")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "MONGO_URI")
}

func TestLoad_MissingKafkaBrokers(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	os.Unsetenv("KAFKA_BROKERS")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_BROKERS")
}

func TestLoad_InvalidPort(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("PORT", "not-a-port")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "PORT")
}

func TestLoad_MultipleBrokers(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "broker1:9092, broker2:9092, broker3:9092")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Len(t, cfg.KafkaBrokers, 3)
	assert.Equal(t, "broker1:9092", cfg.KafkaBrokers[0])
}

func TestLoad_Defaults(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	os.Unsetenv("PORT")
	os.Unsetenv("APP_ENV")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, 3001, cfg.Port)
	assert.Equal(t, "development", cfg.Env)
	assert.Equal(t, "", cfg.RedisURL)
}

func TestLoad_RedisURLOptional(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("REDIS_URL", "redis://localhost:6379")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "redis://localhost:6379", cfg.RedisURL)
}
