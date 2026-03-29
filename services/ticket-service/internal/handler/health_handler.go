package handler

import (
	"context"
	"net/http"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// HealthHandler handles liveness and readiness probes.
type HealthHandler struct {
	repo         repository.TicketRepository
	redisChecker DependencyChecker
	kafkaChecker DependencyChecker
	log          *zap.Logger
}

// DependencyChecker reports readiness of a downstream dependency.
type DependencyChecker interface {
	Ping(ctx context.Context) error
}

// NewHealthHandler creates a new HealthHandler.
func NewHealthHandler(
	repo repository.TicketRepository,
	redisChecker DependencyChecker,
	kafkaChecker DependencyChecker,
	log *zap.Logger,
) *HealthHandler {
	return &HealthHandler{
		repo:         repo,
		redisChecker: redisChecker,
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
// Returns 200 only when MongoDB is reachable; 503 otherwise.
func (h *HealthHandler) Ready(c echo.Context) error {
	ctx := c.Request().Context()

	if err := h.repo.Ping(ctx); err != nil {
		h.log.Warn("readiness check failed: mongo unreachable", zap.Error(err))
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"status": "unavailable",
			"reason": "mongodb unreachable",
		})
	}

	if h.redisChecker != nil {
		if err := h.redisChecker.Ping(ctx); err != nil {
			h.log.Warn("readiness check failed: redis unreachable", zap.Error(err))
			return c.JSON(http.StatusServiceUnavailable, map[string]string{
				"status": "unavailable",
				"reason": "redis unreachable",
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
