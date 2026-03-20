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
	repo repository.TicketRepository
	log  *zap.Logger
}

// NewHealthHandler creates a new HealthHandler.
func NewHealthHandler(repo repository.TicketRepository, log *zap.Logger) *HealthHandler {
	return &HealthHandler{repo: repo, log: log}
}

// Live handles GET /healthz/live.
// Returns 200 if the process is running — no external dependency checks.
func (h *HealthHandler) Live(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

// Ready handles GET /healthz/ready.
// Returns 200 only when MongoDB is reachable; 503 otherwise.
func (h *HealthHandler) Ready(c echo.Context) error {
	if err := h.repo.Ping(context.Background()); err != nil {
		h.log.Warn("readiness check failed: mongo unreachable", zap.Error(err))
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"status": "unavailable",
			"reason": "mongodb unreachable",
		})
	}
	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}
