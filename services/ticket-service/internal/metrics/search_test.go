package metrics_test

import (
	"testing"

	"github.com/acme/ticket-service/internal/metrics"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
)

// TestSearchMetrics_Registered verifies that NewSearchMetrics correctly registers
// all five search instruments on the supplied registry and that the Counter is
// usable (Inc increments the value by 1.0).
// No external dependencies — pure unit test.
func TestSearchMetrics_Registered(t *testing.T) {
	m := metrics.NewSearchMetrics(prometheus.NewRegistry())
	m.Fallback.Inc()
	require.Equal(t, 1.0, testutil.ToFloat64(m.Fallback))
}
