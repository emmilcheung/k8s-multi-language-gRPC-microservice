package config_test

import (
	"os"
	"testing"

	"github.com/acme/attendance-service/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// validEnv sets all required environment variables to valid values and returns a cleanup func.
func validEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgresql://user:pass@localhost:5432/attendance_db")
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("HTTP_PORT", "3007")
	t.Setenv("QR_SIGNING_KEY", "supersecretkey_that_is_long_enough_here")
	t.Setenv("TICKET_SERVICE_URL", "ticket-service:50051")
}

func TestLoad_MissingDatabaseURL(t *testing.T) {
	validEnv(t)
	_ = os.Unsetenv("DATABASE_URL")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "DATABASE_URL is required")
}

func TestLoad_MissingKafkaBrokers(t *testing.T) {
	validEnv(t)
	_ = os.Unsetenv("KAFKA_BROKERS")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_BROKERS is required")
}

func TestLoad_MissingQRSigningKey(t *testing.T) {
	validEnv(t)
	_ = os.Unsetenv("QR_SIGNING_KEY")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "QR_SIGNING_KEY is required")
}

func TestLoad_QRSigningKeyTooShort(t *testing.T) {
	validEnv(t)
	t.Setenv("QR_SIGNING_KEY", "tooshort")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "QR_SIGNING_KEY must be at least 32 characters")
}

func TestLoad_UserIDSigningKeyRequiredInProduction(t *testing.T) {
	validEnv(t)
	t.Setenv("APP_ENV", "production")
	_ = os.Unsetenv("X_USER_ID_SIGNING_KEY")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "X_USER_ID_SIGNING_KEY must be at least 32 characters in production")
}

func TestLoad_UserIDSigningKeyTooShortInProduction(t *testing.T) {
	validEnv(t)
	t.Setenv("APP_ENV", "production")
	t.Setenv("X_USER_ID_SIGNING_KEY", "tooshort")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "X_USER_ID_SIGNING_KEY must be at least 32 characters in production")
}

func TestLoad_UserIDSigningKeyOptionalOutsideProduction(t *testing.T) {
	validEnv(t)
	t.Setenv("APP_ENV", "development")
	_ = os.Unsetenv("X_USER_ID_SIGNING_KEY")
	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Empty(t, cfg.UserIDSigningKey)
}

func TestLoad_InvalidHTTPPort(t *testing.T) {
	validEnv(t)
	t.Setenv("HTTP_PORT", "not-a-port")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "HTTP_PORT")
}

func TestLoad_InvalidOTELEndpoint(t *testing.T) {
	validEnv(t)
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "not-valid-at-all")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "OTEL_EXPORTER_OTLP_ENDPOINT")
}

func TestLoad_ValidOTELEndpointURL(t *testing.T) {
	validEnv(t)
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317")
	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "http://otel-collector:4317", cfg.OTELEndpoint)
}

func TestLoad_ValidOTELEndpointHostPort(t *testing.T) {
	validEnv(t)
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "otel-collector:4317")
	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "otel-collector:4317", cfg.OTELEndpoint)
}

func TestLoad_InvalidKafkaSecurityProtocol(t *testing.T) {
	validEnv(t)
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "INVALID")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_SECURITY_PROTOCOL")
}

func TestLoad_SASLRequiresCredentials(t *testing.T) {
	validEnv(t)
	t.Setenv("KAFKA_SECURITY_PROTOCOL", "SASL_PLAINTEXT")
	_, err := config.Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KAFKA_SASL_MECHANISM")
}

func TestLoad_Success(t *testing.T) {
	validEnv(t)
	t.Setenv("APP_ENV", "test")
	t.Setenv("LOG_LEVEL", "debug")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "test", cfg.Env)
	assert.Equal(t, 3007, cfg.Port)
	assert.Equal(t, "postgresql://user:pass@localhost:5432/attendance_db", cfg.DatabaseURL)
	assert.Equal(t, []string{"localhost:9092"}, cfg.KafkaBrokers)
	assert.NotEmpty(t, cfg.QRSigningKey)
	assert.Equal(t, "ticket-service:50051", cfg.TicketServiceURL)
	assert.Equal(t, "http://auth-service:3000", cfg.AuthServiceURL)
}

func TestLoad_MultipleErrors(t *testing.T) {
	// Clear all env
	_ = os.Unsetenv("DATABASE_URL")
	_ = os.Unsetenv("KAFKA_BROKERS")
	_ = os.Unsetenv("QR_SIGNING_KEY")
	_ = os.Unsetenv("TICKET_SERVICE_URL")
	t.Setenv("HTTP_PORT", "3007")

	_, err := config.Load()
	require.Error(t, err)
	// Should report all missing fields
	assert.Contains(t, err.Error(), "DATABASE_URL")
	assert.Contains(t, err.Error(), "KAFKA_BROKERS")
	assert.Contains(t, err.Error(), "QR_SIGNING_KEY")
	assert.Contains(t, err.Error(), "TICKET_SERVICE_URL")
}
