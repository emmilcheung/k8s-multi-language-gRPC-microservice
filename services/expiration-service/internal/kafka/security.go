package kafka

import (
	"fmt"
	"strings"

	confluent "github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

type SecurityConfig struct {
	SecurityProtocol string
	SASLMechanism    string
	SASLUsername     string
	SASLPassword     string
	SSLCALocation    string
}

func (c SecurityConfig) Apply(cfg *confluent.ConfigMap) error {
	protocol := strings.ToUpper(strings.TrimSpace(c.SecurityProtocol))
	if protocol == "" {
		protocol = "PLAINTEXT"
	}

	if err := setKafkaConfigValue(cfg, "security.protocol", protocol); err != nil {
		return err
	}

	if c.SSLCALocation != "" {
		if err := setKafkaConfigValue(cfg, "ssl.ca.location", c.SSLCALocation); err != nil {
			return err
		}
	}

	switch protocol {
	case "PLAINTEXT", "SSL":
		return nil
	case "SASL_PLAINTEXT", "SASL_SSL":
		if err := setKafkaConfigValue(cfg, "sasl.mechanisms", strings.ToUpper(strings.TrimSpace(c.SASLMechanism))); err != nil {
			return err
		}
		if err := setKafkaConfigValue(cfg, "sasl.username", c.SASLUsername); err != nil {
			return err
		}
		if err := setKafkaConfigValue(cfg, "sasl.password", c.SASLPassword); err != nil {
			return err
		}
		return nil
	default:
		return fmt.Errorf("unsupported kafka security protocol %q", c.SecurityProtocol)
	}
}

func firstSecurityConfig(configs []SecurityConfig) SecurityConfig {
	if len(configs) > 0 {
		return configs[0]
	}
	return SecurityConfig{SecurityProtocol: "PLAINTEXT"}
}

func setKafkaConfigValue(cfg *confluent.ConfigMap, key string, value interface{}) error {
	if err := cfg.SetKey(key, value); err != nil {
		return fmt.Errorf("set kafka config %s: %w", key, err)
	}
	return nil
}
