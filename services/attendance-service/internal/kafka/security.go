// Package kafka provides Kafka producer and consumer bootstrap for attendance-service.
package kafka

import (
	"fmt"
	"strings"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// SecurityConfig holds Kafka TLS/SASL settings.
type SecurityConfig struct {
	SecurityProtocol string
	SASLMechanism    string
	SASLUsername     string
	SASLPassword     string
	SSLCALocation    string
}

// Apply writes the security config into a Kafka ConfigMap.
func (c SecurityConfig) Apply(cfg *confluent.ConfigMap) error {
	protocol := strings.ToUpper(strings.TrimSpace(c.SecurityProtocol))
	if protocol == "" {
		protocol = "PLAINTEXT"
	}
	if err := cfg.SetKey("security.protocol", protocol); err != nil {
		return fmt.Errorf("set security.protocol: %w", err)
	}
	if c.SSLCALocation != "" {
		if err := cfg.SetKey("ssl.ca.location", c.SSLCALocation); err != nil {
			return fmt.Errorf("set ssl.ca.location: %w", err)
		}
	}
	switch protocol {
	case "PLAINTEXT", "SSL":
		return nil
	case "SASL_PLAINTEXT", "SASL_SSL":
		if err := cfg.SetKey("sasl.mechanisms", strings.ToUpper(strings.TrimSpace(c.SASLMechanism))); err != nil {
			return fmt.Errorf("set sasl.mechanisms: %w", err)
		}
		if err := cfg.SetKey("sasl.username", c.SASLUsername); err != nil {
			return fmt.Errorf("set sasl.username: %w", err)
		}
		if err := cfg.SetKey("sasl.password", c.SASLPassword); err != nil {
			return fmt.Errorf("set sasl.password: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unsupported kafka security protocol %q", c.SecurityProtocol)
	}
}
