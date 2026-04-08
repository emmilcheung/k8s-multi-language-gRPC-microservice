package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all configuration for ticket-service.
// All fields are validated at startup — the service refuses to start if anything is missing.
type Config struct {
	Env              string
	Port             int
	GrpcPort         int
	LogLevel         string
	MongoURI         string
	MongoDB          string
	KafkaBrokers     []string
	RedisURL         string
	VenueServiceAddr string // WS3: gRPC address of venue-service (e.g. "localhost:9091")
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

	venueServiceAddr := getEnv("VENUE_SERVICE_ADDR", "localhost:9091")

	if len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "; "))
	}

	return &Config{
		Env:              env,
		Port:             port,
		GrpcPort:         grpcPort,
		LogLevel:         logLevel,
		MongoURI:         mongoURI,
		MongoDB:          mongoDB,
		KafkaBrokers:     kafkaBrokers,
		RedisURL:         redisURL,
		VenueServiceAddr: venueServiceAddr,
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
