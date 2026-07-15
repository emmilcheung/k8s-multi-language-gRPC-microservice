package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const minSigningKeyLength = 32

// Config holds all configuration for attendance-service.
// All required fields are validated at startup — the service refuses to start if anything is missing.
type Config struct {
	Env                   string
	Port                  int
	LogLevel              string
	DatabaseURL           string
	KafkaBrokers          []string
	KafkaSecurityProtocol string
	KafkaSASLMechanism    string
	KafkaSASLUsername     string
	KafkaSASLPassword     string
	KafkaSSLCALocation    string
	QRSigningKey          string
	TicketServiceURL      string
	AuthServiceURL        string
	UserIDSigningKey      string
	OTELEndpoint          string        // optional; schema-validated if present
	QRTokenTTL            time.Duration // configurable via QR_TOKEN_TTL; 0 means use service default (48h)
}

// Load reads configuration from environment variables and validates all required fields.
// Returns an error if any required field is missing or invalid.
func Load() (*Config, error) {
	var errs []string

	env := getEnv("APP_ENV", "development")
	logLevel := getEnv("LOG_LEVEL", "info")

	portStr := getEnv("HTTP_PORT", "3007")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, fmt.Sprintf("HTTP_PORT must be a valid port number, got %q", portStr))
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}

	kafkaBrokersStr := os.Getenv("KAFKA_BROKERS")
	if kafkaBrokersStr == "" {
		errs = append(errs, "KAFKA_BROKERS is required")
	}
	kafkaBrokers := splitAndTrim(kafkaBrokersStr)

	kafkaSecurityProtocol := strings.ToUpper(strings.TrimSpace(getEnv("KAFKA_SECURITY_PROTOCOL", "PLAINTEXT")))
	switch kafkaSecurityProtocol {
	case "PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL":
	default:
		errs = append(errs, fmt.Sprintf("KAFKA_SECURITY_PROTOCOL must be one of PLAINTEXT, SSL, SASL_PLAINTEXT, SASL_SSL, got %q", kafkaSecurityProtocol))
	}

	kafkaSASLMechanism := strings.TrimSpace(getEnv("KAFKA_SASL_MECHANISM", ""))
	kafkaSASLUsername := strings.TrimSpace(getEnv("KAFKA_SASL_USERNAME", ""))
	kafkaSASLPassword := strings.TrimSpace(getEnv("KAFKA_SASL_PASSWORD", ""))
	kafkaSSLCALocation := strings.TrimSpace(getEnv("KAFKA_SSL_CA_LOCATION", ""))
	if strings.HasPrefix(kafkaSecurityProtocol, "SASL") {
		if kafkaSASLMechanism == "" {
			errs = append(errs, "KAFKA_SASL_MECHANISM is required when KAFKA_SECURITY_PROTOCOL uses SASL")
		}
		if kafkaSASLUsername == "" {
			errs = append(errs, "KAFKA_SASL_USERNAME is required when KAFKA_SECURITY_PROTOCOL uses SASL")
		}
		if kafkaSASLPassword == "" {
			errs = append(errs, "KAFKA_SASL_PASSWORD is required when KAFKA_SECURITY_PROTOCOL uses SASL")
		}
	}

	qrSigningKey := os.Getenv("QR_SIGNING_KEY")
	if qrSigningKey == "" {
		errs = append(errs, "QR_SIGNING_KEY is required")
	} else if len(qrSigningKey) < minSigningKeyLength {
		errs = append(errs, fmt.Sprintf("QR_SIGNING_KEY must be at least %d characters, got %d", minSigningKeyLength, len(qrSigningKey)))
	}

	ticketServiceURL := strings.TrimSpace(os.Getenv("TICKET_SERVICE_URL"))
	if ticketServiceURL == "" {
		errs = append(errs, "TICKET_SERVICE_URL is required")
	}
	authServiceURL := strings.TrimSpace(getEnv("AUTH_SERVICE_URL", "http://auth-service:3000"))
	if _, err := url.ParseRequestURI(authServiceURL); err != nil {
		errs = append(errs, fmt.Sprintf("AUTH_SERVICE_URL must be a valid URL, got %q", authServiceURL))
	}

	userIDSigningKey := getEnv("X_USER_ID_SIGNING_KEY", "")
	if env == "production" && len(userIDSigningKey) < minSigningKeyLength {
		errs = append(errs, fmt.Sprintf("X_USER_ID_SIGNING_KEY must be at least %d characters in production, got %d", minSigningKeyLength, len(userIDSigningKey)))
	}

	otelEndpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if otelEndpoint != "" {
		if err := validateOTELEndpoint(otelEndpoint); err != nil {
			errs = append(errs, fmt.Sprintf("OTEL_EXPORTER_OTLP_ENDPOINT is invalid: %v", err))
		}
	}

	var qrTokenTTL time.Duration
	if raw := strings.TrimSpace(os.Getenv("QR_TOKEN_TTL")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			errs = append(errs, fmt.Sprintf("QR_TOKEN_TTL must be a positive duration (e.g. \"48h\"), got %q", raw))
		} else {
			qrTokenTTL = d
		}
	}

	if len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "; "))
	}

	return &Config{
		Env:                   env,
		Port:                  port,
		LogLevel:              logLevel,
		DatabaseURL:           databaseURL,
		KafkaBrokers:          kafkaBrokers,
		KafkaSecurityProtocol: kafkaSecurityProtocol,
		KafkaSASLMechanism:    kafkaSASLMechanism,
		KafkaSASLUsername:     kafkaSASLUsername,
		KafkaSASLPassword:     kafkaSASLPassword,
		KafkaSSLCALocation:    kafkaSSLCALocation,
		QRSigningKey:          qrSigningKey,
		TicketServiceURL:      ticketServiceURL,
		AuthServiceURL:        authServiceURL,
		UserIDSigningKey:      userIDSigningKey,
		OTELEndpoint:          otelEndpoint,
		QRTokenTTL:            qrTokenTTL,
	}, nil
}

// validateOTELEndpoint checks that the endpoint is a valid host:port or URL.
func validateOTELEndpoint(endpoint string) error {
	// Accept bare host:port (no scheme) or full URL.
	if strings.Contains(endpoint, "://") {
		u, err := url.Parse(endpoint)
		if err != nil {
			return fmt.Errorf("parse error: %w", err)
		}
		if u.Host == "" {
			return fmt.Errorf("missing host in URL %q", endpoint)
		}
		return nil
	}
	// bare host:port
	parts := strings.SplitN(endpoint, ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return fmt.Errorf("must be host:port or a valid URL, got %q", endpoint)
	}
	port, err := strconv.Atoi(parts[1])
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("invalid port in %q", endpoint)
	}
	return nil
}

func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func splitAndTrim(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
