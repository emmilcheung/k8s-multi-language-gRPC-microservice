package service

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	scanValidationsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "attendance_scan_validations_total",
			Help: "Total scan validation attempts by result class.",
		},
		[]string{"result"},
	)
	scanCheckInsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "attendance_scan_checkins_total",
			Help: "Total scan check-in attempts by result class.",
		},
		[]string{"result"},
	)
	issuanceCountTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "attendance_issuance_total",
			Help: "Total number of admission credentials issued.",
		},
	)
	issuanceLatencySeconds = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "attendance_issuance_latency_seconds",
			Help:    "Time spent handling order-completed events for issuance.",
			Buckets: prometheus.DefBuckets,
		},
	)
)

func observeScanValidation(result ScanResultClass) {
	scanValidationsTotal.WithLabelValues(string(result)).Inc()
}

func observeScanCheckIn(result ScanResultClass) {
	scanCheckInsTotal.WithLabelValues(string(result)).Inc()
}

func observeIssuance(units int, durationSeconds float64) {
	if units > 0 {
		issuanceCountTotal.Add(float64(units))
	}
	issuanceLatencySeconds.Observe(durationSeconds)
}
