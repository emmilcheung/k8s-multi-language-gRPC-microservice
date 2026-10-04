package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all configuration for venue-service.
// All fields are validated at startup — the service refuses to start if anything is missing.
type Config struct {
	Env                   string
	Port                  int
	GrpcPort              int
	LogLevel              string
	DatabaseURL           string
	DBPoolMax             int
	KafkaBrokers          []string
	KafkaSecurityProtocol string
	KafkaSASLMechanism    string
	KafkaSASLUsername     string
	KafkaSASLPassword     string
	KafkaSSLCALocation    string
	RedisURL              string
	TicketServiceURL      string
	HoldTTLSec            int
	UserIDSigningKey      string
	// SeatedCapEnforced applies each ticket's maxPerUser to seated holds and
	// reserves. Off by default: ticket-service defaults maxPerUser to 1, so
	// turning it on before the seated tickets' limits are reviewed would cut
	// existing events to one seat per buyer.
	SeatedCapEnforced bool
}

// Load reads configuration from environment variables and validates all required fields.
// Returns an error if any required field is missing or invalid.
func Load() (*Config, error) {
	var errs []string

	env := getEnv("APP_ENV", "development")
	logLevel := getEnv("LOG_LEVEL", "info")

	// Postgres pool ceiling for this process. What the database sees is this
	// number times the pod count, so it belongs next to the HPA maxReplicas that
	// multiplies it; see the connection budget in docs/05-data-conventions.md.
	// pgx's own default is max(4, GOMAXPROCS), which varies with the CPU limit
	// and so is not a number anyone budgeted for.
	dbPoolMaxStr := getEnv("DB_POOL_MAX", "10")
	dbPoolMax, err := strconv.Atoi(dbPoolMaxStr)
	if err != nil || dbPoolMax < 1 {
		errs = append(errs, fmt.Sprintf("DB_POOL_MAX must be a positive integer, got %q", dbPoolMaxStr))
	}

	portStr := getEnv("PORT", "3003")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, fmt.Sprintf("PORT must be a valid port number, got %q", portStr))
	}

	grpcPortStr := getEnv("GRPC_PORT", "50052")
	grpcPort, err := strconv.Atoi(grpcPortStr)
	if err != nil || grpcPort < 1 || grpcPort > 65535 {
		errs = append(errs, fmt.Sprintf("GRPC_PORT must be a valid port number, got %q", grpcPortStr))
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
	kafkaSASLMechanism := strings.ToUpper(strings.TrimSpace(getEnv("KAFKA_SASL_MECHANISM", "")))
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

	redisURL := getEnv("REDIS_URL", "")

	ticketServiceURL := os.Getenv("TICKET_SERVICE_URL")
	if ticketServiceURL == "" {
		errs = append(errs, "TICKET_SERVICE_URL is required")
	}

	holdTTLSecStr := getEnv("HOLD_TTL_SEC", "600")
	holdTTLSec, err := strconv.Atoi(holdTTLSecStr)
	if err != nil || holdTTLSec <= 0 {
		errs = append(errs, fmt.Sprintf("HOLD_TTL_SEC must be a positive integer, got %q", holdTTLSecStr))
	}

	userIDSigningKey := getEnv("X_USER_ID_SIGNING_KEY", "")

	seatedCapStr := getEnv("SEATED_CAP_ENFORCED", "false")
	seatedCapEnforced, err := strconv.ParseBool(seatedCapStr)
	if err != nil {
		errs = append(errs, fmt.Sprintf("SEATED_CAP_ENFORCED must be true or false, got %q", seatedCapStr))
	}

	if len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "; "))
	}

	return &Config{
		Env:                   env,
		Port:                  port,
		GrpcPort:              grpcPort,
		LogLevel:              logLevel,
		DatabaseURL:           databaseURL,
		DBPoolMax:             dbPoolMax,
		KafkaBrokers:          kafkaBrokers,
		KafkaSecurityProtocol: kafkaSecurityProtocol,
		KafkaSASLMechanism:    kafkaSASLMechanism,
		KafkaSASLUsername:     kafkaSASLUsername,
		KafkaSASLPassword:     kafkaSASLPassword,
		KafkaSSLCALocation:    kafkaSSLCALocation,
		RedisURL:              redisURL,
		TicketServiceURL:      ticketServiceURL,
		HoldTTLSec:            holdTTLSec,
		UserIDSigningKey:      userIDSigningKey,
		SeatedCapEnforced:     seatedCapEnforced,
	}, nil
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
