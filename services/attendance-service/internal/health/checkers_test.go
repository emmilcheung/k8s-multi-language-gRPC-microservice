package health

import (
	"context"
	"strings"
	"testing"

	appkafka "github.com/acme/attendance-service/internal/kafka"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestKafkaChecker_Ping_WithUnsupportedProtocol_ReturnsSecurityError verifies that
// KafkaChecker.Ping applies the security config before contacting the broker.
//
// An unsupported security protocol must surface a config error (not a broker
// transport error), proving that SecurityConfig.Apply is invoked inside Ping.
// Before the fix, Apply is never called so the error comes from the metadata
// fetch (broker unreachable), which does NOT contain the expected substring.
func TestKafkaChecker_Ping_WithUnsupportedProtocol_ReturnsSecurityError(t *testing.T) {
	checker := NewKafkaChecker(
		[]string{"localhost:19092"}, // deliberately unreachable
		appkafka.SecurityConfig{SecurityProtocol: "UNSUPPORTED_PROTO"},
	)

	err := checker.Ping(context.Background())

	require.Error(t, err)
	assert.True(t, strings.Contains(err.Error(), "unsupported kafka security protocol"),
		"Ping must surface security-config error, not a broker-transport error; got: %v", err)
}

// TestNewKafkaChecker_NoSecurityArg_ConstructsSuccessfully verifies that
// NewKafkaChecker remains callable without a security argument (backwards compat).
func TestNewKafkaChecker_NoSecurityArg_ConstructsSuccessfully(t *testing.T) {
	checker := NewKafkaChecker([]string{"localhost:19092"})
	assert.NotNil(t, checker)
}
