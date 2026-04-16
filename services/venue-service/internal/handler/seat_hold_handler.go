package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// HoldManager is the narrow interface SeatHoldHandler needs from the hold package.
type HoldManager interface {
	HoldSeats(ctx context.Context, planID, userID, sessionID string, seatIDs []string) (*hold.HoldResult, error)
	ReleaseHold(ctx context.Context, planID, userID string, seatIDs []string) error
	GetAvailability(ctx context.Context, planID string) (*hold.AvailabilitySnapshot, error)
}

// SeatHoldHandler handles seat hold, release, and availability endpoints.
type SeatHoldHandler struct {
	holdMgr   HoldManager
	validator *security.UserIDSignatureValidator
	log       *zap.Logger
}

// NewSeatHoldHandler creates a new SeatHoldHandler.
func NewSeatHoldHandler(holdMgr HoldManager, validator *security.UserIDSignatureValidator, log *zap.Logger) *SeatHoldHandler {
	return &SeatHoldHandler{holdMgr: holdMgr, validator: validator, log: log}
}

// RegisterRoutes attaches hold/release/availability routes to the given plan group.
// Expects to be registered under /api/seating-plans/:planId.
func (h *SeatHoldHandler) RegisterRoutes(g *echo.Group) {
	g.POST("/seats/hold", h.HoldSeats)
	g.POST("/seats/release", h.ReleaseHold)
	g.GET("/availability", h.GetAvailability)
}

// holdRequest is the request body for POST /seats/hold.
// userId is intentionally absent — it is derived from the X-User-Id header.
type holdRequest struct {
	SeatIDs   []string `json:"seatIds"`
	SessionID string   `json:"sessionId"`
}

// releaseRequest is the request body for POST /seats/release.
type releaseRequest struct {
	SeatIDs []string `json:"seatIds"`
}

// HoldSeats handles POST /api/seating-plans/:planId/seats/hold.
//
//	Request body: { "seatIds": ["..."], "sessionId": "..." }
//	Response: { "held": ["..."], "expiresAt": "..." }
//
// The userId is derived from the Kong-injected X-User-Id header.
// Any client-supplied userId in the body is rejected per design decision D-08.
// X-User-Id-Sig must be valid; missing or invalid signatures result in 401.
func (h *SeatHoldHandler) HoldSeats(c echo.Context) error {
	userID := c.Request().Header.Get("X-User-Id")
	if userID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(userID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	planID := c.Param("planId")

	var req holdRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if len(req.SeatIDs) == 0 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("seatIds is required and must not be empty"))
	}

	result, err := h.holdMgr.HoldSeats(c.Request().Context(), planID, userID, req.SessionID, req.SeatIDs)
	if err != nil {
		return h.handleHoldError(c, err, planID)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"held":      result.Held,
		"expiresAt": result.ExpiresAt,
	})
}

// ReleaseHold handles POST /api/seating-plans/:planId/seats/release.
//
//	Request body: { "seatIds": ["..."] }
//	Response: 204 No Content
func (h *SeatHoldHandler) ReleaseHold(c echo.Context) error {
	userID := c.Request().Header.Get("X-User-Id")
	if userID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(userID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	planID := c.Param("planId")

	var req releaseRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if len(req.SeatIDs) == 0 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("seatIds is required and must not be empty"))
	}

	if err := h.holdMgr.ReleaseHold(c.Request().Context(), planID, userID, req.SeatIDs); err != nil {
		h.log.Error("seat release failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.NoContent(http.StatusNoContent)
}

// GetAvailability handles GET /api/seating-plans/:planId/availability.
//
//	Response: { "planId": "...", "seatMap": { seatId: status }, "counts": {...}, "cachedAt": "..." }
func (h *SeatHoldHandler) GetAvailability(c echo.Context) error {
	planID := c.Param("planId")

	snap, err := h.holdMgr.GetAvailability(c.Request().Context(), planID)
	if err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("get availability failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, snap)
}

// ── helpers ───────────────────────────────────────────────────────────────────

func (h *SeatHoldHandler) handleHoldError(c echo.Context, err error, planID string) error {
	switch {
	case errors.Is(err, repository.ErrPlanNotFound):
		return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
	case errors.Is(err, hold.ErrPlanNotActive):
		return c.JSON(http.StatusConflict, errorResponse("seating plan is not active"))
	case errors.Is(err, repository.ErrSeatNotAvailable):
		return c.JSON(http.StatusConflict, errorResponse("one or more seats are not available"))
	default:
		h.log.Error("seat hold failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
}
