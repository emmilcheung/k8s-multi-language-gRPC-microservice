package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config holds all configuration for ticket-service.
// All fields are validated at startup — the service refuses to start if anything is missing.
type Config struct {
	Env                   string
	Port                  int
	GrpcPort              int
	LogLevel              string
	MongoURI              string
	MongoDB               string
	KafkaBrokers          []string
	KafkaSecurityProtocol string
	KafkaSASLMechanism    string
	KafkaSASLUsername     string
	KafkaSASLPassword     string
	KafkaSSLCALocation    string
	RedisURL              string
	VenueServiceAddr      string // WS3: gRPC address of venue-service (e.g. "localhost:9091")
	SearchBackend         string // "mongo" (default) | "opensearch"
	OpenSearchURL         string
	OpenSearchIndex       string
}

// Load reads configuration from environment variables and validates all required fields.
// Returns an error if any required field is missing or invalid.
func Load() (*Config, error) {
	var errs []string

	env := getEnv("APP_ENV", "development")
	logLevel := getEnv("LOG_LEVEL", "info")

	portStr := getEnv("PORT", "3001")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, fmt.Sprintf("PORT must be a valid port number, got %q", portStr))
	}

	grpcPortStr := getEnv("GRPC_PORT", "9090")
	grpcPort, err := strconv.Atoi(grpcPortStr)
	if err != nil || grpcPort < 1 || grpcPort > 65535 {
		errs = append(errs, fmt.Sprintf("GRPC_PORT must be a valid port number, got %q", grpcPortStr))
	}

	mongoURI := os.Getenv("MONGO_URI")
	if mongoURI == "" {
		errs = append(errs, "MONGO_URI is required")
	}

	mongoDB := getEnv("MONGO_DB", "tickets")
	redisURL := getEnv("REDIS_URL", "")

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

	venueServiceAddr := getEnv("VENUE_SERVICE_ADDR", "localhost:9091")

	searchBackend := getEnv("SEARCH_BACKEND", "mongo")
	openSearchURL := os.Getenv("OPENSEARCH_URL")
	openSearchIndex := getEnv("OPENSEARCH_INDEX", "tickets")
	if searchBackend == "opensearch" {
		if _, err := url.ParseRequestURI(openSearchURL); err != nil {
			errs = append(errs, fmt.Sprintf("SEARCH_BACKEND=opensearch requires a valid OPENSEARCH_URL: %v", err))
		}
	}

	if len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "; "))
	}

	return &Config{
		Env:                   env,
		Port:                  port,
		GrpcPort:              grpcPort,
		LogLevel:              logLevel,
		MongoURI:              mongoURI,
		MongoDB:               mongoDB,
		KafkaBrokers:          kafkaBrokers,
		KafkaSecurityProtocol: kafkaSecurityProtocol,
		KafkaSASLMechanism:    kafkaSASLMechanism,
		KafkaSASLUsername:     kafkaSASLUsername,
		KafkaSASLPassword:     kafkaSASLPassword,
		KafkaSSLCALocation:    kafkaSSLCALocation,
		RedisURL:              redisURL,
		VenueServiceAddr:      venueServiceAddr,
		SearchBackend:         searchBackend,
		OpenSearchURL:         openSearchURL,
		OpenSearchIndex:       openSearchIndex,
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
