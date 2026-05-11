package handler

import (
	"context"
	"net/http"

	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// DependencyChecker reports readiness of a downstream dependency.
type DependencyChecker interface {
	Ping(ctx context.Context) error
}

// HealthHandler handles liveness and readiness probes.
type HealthHandler struct {
	dbChecker    DependencyChecker
	kafkaChecker DependencyChecker
	log          *zap.Logger
}

// NewHealthHandler creates a new HealthHandler with PostgreSQL and Kafka checkers.
func NewHealthHandler(dbChecker, kafkaChecker DependencyChecker, log *zap.Logger) *HealthHandler {
	return &HealthHandler{
		dbChecker:    dbChecker,
		kafkaChecker: kafkaChecker,
		log:          log,
	}
}

// Live handles GET /healthz/live.
// Returns 200 if the process is running — no external dependency checks.
func (h *HealthHandler) Live(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

// Ready handles GET /healthz/ready.
// Returns 200 only when PostgreSQL and Kafka are reachable; 503 otherwise.
func (h *HealthHandler) Ready(c echo.Context) error {
	ctx := c.Request().Context()

	if h.dbChecker != nil {
		if err := h.dbChecker.Ping(ctx); err != nil {
			h.log.Warn("readiness check failed: postgres unreachable", zap.Error(err))
			return c.JSON(http.StatusServiceUnavailable, map[string]string{
				"status": "unavailable",
				"reason": "postgres unreachable",
			})
		}
	}

	if h.kafkaChecker != nil {
		if err := h.kafkaChecker.Ping(ctx); err != nil {
			h.log.Warn("readiness check failed: kafka unreachable", zap.Error(err))
			return c.JSON(http.StatusServiceUnavailable, map[string]string{
				"status": "unavailable",
				"reason": "kafka unreachable",
			})
		}
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}
