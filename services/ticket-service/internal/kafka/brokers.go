package kafka

import "strings"

// joinBrokers joins a slice of broker addresses into a comma-separated string
// suitable for use as a Kafka bootstrap.servers config value.
func joinBrokers(brokers []string) string {
	return strings.Join(brokers, ",")
}
