package config

import (
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
	assert.Equal(t, "PLAINTEXT", cfg.KafkaSecurityProtocol)
	assert.Equal(t, "", cfg.RedisURL)
}

func TestLoad_MissingMongoURI(t *testing.T) {
	t.Setenv("MONGO_URI", "")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "MONGO_URI")
}

func TestLoad_MissingKafkaBrokers(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "")

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
	t.Setenv("PORT", "")
	t.Setenv("APP_ENV", "")

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

func TestLoad_KafkaSASLRequiresCredentials(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
	t.Setenv("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_SASL_USERNAME")
	assert.Contains(t, err.Error(), "KAFKA_SASL_PASSWORD")
}

func TestLoad_KafkaSASLConfig(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
	t.Setenv("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256")
	t.Setenv("KAFKA_SASL_USERNAME", "ticket-service")
	t.Setenv("KAFKA_SASL_PASSWORD", "secret")
	t.Setenv("KAFKA_SSL_CA_LOCATION", "/etc/ssl/certs/ca.pem")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "SASL_SSL", cfg.KafkaSecurityProtocol)
	assert.Equal(t, "SCRAM-SHA-256", cfg.KafkaSASLMechanism)
	assert.Equal(t, "ticket-service", cfg.KafkaSASLUsername)
	assert.Equal(t, "secret", cfg.KafkaSASLPassword)
	assert.Equal(t, "/etc/ssl/certs/ca.pem", cfg.KafkaSSLCALocation)
}

func TestConfig_SearchBackendOpensearch_RequiresValidURL(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("SEARCH_BACKEND", "opensearch")
	t.Setenv("OPENSEARCH_URL", "") // missing
	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "OPENSEARCH_URL")
}

func TestConfig_DefaultsToMongoBackend(t *testing.T) {
	t.Setenv("MONGO_URI", "mongodb://localhost:27017")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "mongo", cfg.SearchBackend)
	require.Equal(t, "tickets", cfg.OpenSearchIndex)
}
