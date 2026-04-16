package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all configuration for expiration-service.
// All fields are validated at startup — the service refuses to start if anything is missing.
type Config struct {
	Env                   string
	Port                  int
	LogLevel              string
	RedisAddr             string
	KafkaBrokers          []string
	KafkaSecurityProtocol string
	KafkaSASLMechanism    string
	KafkaSASLUsername     string
	KafkaSASLPassword     string
	KafkaSSLCALocation    string
}

// Load reads configuration from environment variables and validates all required fields.
// Returns an error if any required field is missing or invalid.
func Load() (*Config, error) {
	var errs []string

	env := getEnv("APP_ENV", "development")
	logLevel := getEnv("LOG_LEVEL", "info")

	portStr := getEnv("PORT", "8080")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, fmt.Sprintf("PORT must be a valid port number, got %q", portStr))
	}

	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		errs = append(errs, "REDIS_ADDR is required")
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

	if len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "; "))
	}

	return &Config{
		Env:                   env,
		Port:                  port,
		LogLevel:              logLevel,
		RedisAddr:             redisAddr,
		KafkaBrokers:          kafkaBrokers,
		KafkaSecurityProtocol: kafkaSecurityProtocol,
		KafkaSASLMechanism:    kafkaSASLMechanism,
		KafkaSASLUsername:     kafkaSASLUsername,
		KafkaSASLPassword:     kafkaSASLPassword,
		KafkaSSLCALocation:    kafkaSSLCALocation,
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
