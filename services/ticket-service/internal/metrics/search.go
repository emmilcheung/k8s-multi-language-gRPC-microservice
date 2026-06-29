package metrics

import "github.com/prometheus/client_golang/prometheus"

// SearchMetrics holds the Prometheus instruments for the OpenSearch search subsystem.
// All instruments are registered on the provided registry so tests can use a private
// registry without polluting the default (global) one.
type SearchMetrics struct {
	// QueryDuration observes end-to-end latency of each search path.
	// Label: backend="opensearch"|"mongo"
	QueryDuration *prometheus.HistogramVec

	// Fallback counts the number of times a failed OpenSearch query caused the
	// resolver to fall back to the Mongo path.
	Fallback prometheus.Counter

	// IndexerLag observes the wall-clock lag between a ticket event's CreatedAt
	// timestamp and the moment the indexer processes it.
	IndexerLag prometheus.Histogram

	// RefillIterations observes how many refill-loop iterations the TicketsConnection
	// resolver needed per request.
	RefillIterations prometheus.Histogram

	// ReindexProgress is a gauge that tracks how many documents have been upserted
	// during a Reindex run.
	ReindexProgress prometheus.Gauge
}

// NewSearchMetrics registers and returns the search metric instruments on reg.
// Pass prometheus.NewRegistry() in tests; pass prometheus.DefaultRegisterer in production.
func NewSearchMetrics(reg prometheus.Registerer) *SearchMetrics {
	queryDuration := prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "search_query_duration_seconds",
		Help:    "End-to-end latency of a ticket search query, by backend.",
		Buckets: prometheus.DefBuckets,
	}, []string{"backend"})

	fallback := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "search_fallback_total",
		Help: "Total number of times an OpenSearch query failure caused a Mongo fallback.",
	})

	indexerLag := prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "search_indexer_lag_seconds",
		Help:    "Lag between a ticket event's creation timestamp and indexer processing time.",
		Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60},
	})

	refillIterations := prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "search_refill_iterations",
		Help:    "Number of refill-loop iterations per TicketsConnection resolver call.",
		Buckets: []float64{1, 2, 3, 4, 5},
	})

	reindexProgress := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "reindex_progress",
		Help: "Number of documents upserted so far in the current Reindex run.",
	})

	reg.MustRegister(queryDuration, fallback, indexerLag, refillIterations, reindexProgress)

	return &SearchMetrics{
		QueryDuration:    queryDuration,
		Fallback:         fallback,
		IndexerLag:       indexerLag,
		RefillIterations: refillIterations,
		ReindexProgress:  reindexProgress,
	}
}
