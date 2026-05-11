package handler

import (
	"errors"
	"net/http"

	"github.com/acme/attendance-service/internal/middleware"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/service"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// ScanHandler handles scanner REST endpoints.
// Stub implementation: business logic (token verification, scan recording) is wired in WS2.
type ScanHandler struct {
	svc  service.ScanService
	auth service.AttendanceService
	log  *zap.Logger
}

// NewScanHandler creates a new ScanHandler.
func NewScanHandler(svc service.ScanService, auth service.AttendanceService, log *zap.Logger) *ScanHandler {
	return &ScanHandler{svc: svc, auth: auth, log: log}
}

// ValidateToken handles POST /api/attendance/scan/validate
// Scanner endpoint: validates a QR token without recording admission.
func (h *ScanHandler) ValidateToken(c echo.Context) error {
	var req struct {
		Token    string  `json:"token"`
		EventID  string  `json:"eventId"`
		DeviceID string  `json:"deviceId"`
		GateID   *string `json:"gateId"`
	}
	if err := c.Bind(&req); err != nil {
		return jsonError(c, http.StatusBadRequest, "INVALID_BODY", "invalid request body")
	}
	if req.Token == "" || req.EventID == "" || req.DeviceID == "" {
		return jsonError(c, http.StatusBadRequest, "INVALID_BODY", "token, eventId, and deviceId are required")
	}

	scannerUserID := middleware.RequireUserID(c)
	if scannerUserID == "" {
		return jsonError(c, http.StatusUnauthorized, "MISSING_USER_ID", "scanner identity required")
	}
	if err := h.auth.EnsureOrganizerOwnsEvent(c.Request().Context(), req.EventID, scannerUserID); err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return jsonError(c, http.StatusForbidden, "FORBIDDEN", "scanner is not allowed")
		}
		if errors.Is(err, repository.ErrNotFound) {
			return jsonError(c, http.StatusNotFound, "NOT_FOUND", "event not found")
		}
		h.log.Error("ScanHandler.ValidateToken: authorization error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}

	// Enforce require_qr_for_entry: QR scanning is only available when the
	// organizer has explicitly enabled QR-based admission for the event.
	// Default when no policy row exists: require_qr_for_entry = false → blocked.
	validatePolicy, pErr := h.auth.GetAttendancePolicy(c.Request().Context(), req.EventID)
	if pErr != nil && !errors.Is(pErr, repository.ErrNotFound) {
		h.log.Error("ScanHandler.ValidateToken: policy fetch error", zap.Error(pErr))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	if errors.Is(pErr, repository.ErrNotFound) {
		validatePolicy = nil
	}
	if validatePolicy == nil || !validatePolicy.RequireQRForEntry {
		return jsonError(c, http.StatusForbidden, "POLICY_BLOCK", "QR admission is not enabled for this event")
	}

	outcome, err := h.svc.Validate(c.Request().Context(), req.Token, req.EventID, scannerUserID, req.DeviceID, req.GateID)
	if err != nil {
		h.log.Error("ScanHandler.ValidateToken: service error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	return c.JSON(http.StatusOK, map[string]any{
		"result":       outcome.Result,
		"credentialId": outcome.CredentialID,
		"eventId":      outcome.EventID,
		"status":       outcome.Status,
	})
}

// CheckIn handles POST /api/attendance/scan/check-in
// Scanner endpoint: verifies and records a check-in scan event.
func (h *ScanHandler) CheckIn(c echo.Context) error {
	var req struct {
		Token    string  `json:"token"`
		EventID  string  `json:"eventId"`
		DeviceID string  `json:"deviceId"`
		GateID   *string `json:"gateId"`
	}
	if err := c.Bind(&req); err != nil {
		return jsonError(c, http.StatusBadRequest, "INVALID_BODY", "invalid request body")
	}
	if req.Token == "" || req.EventID == "" || req.DeviceID == "" {
		return jsonError(c, http.StatusBadRequest, "INVALID_BODY", "token, eventId, and deviceId are required")
	}

	scannerUserID := middleware.RequireUserID(c)
	if scannerUserID == "" {
		return jsonError(c, http.StatusUnauthorized, "MISSING_USER_ID", "scanner identity required")
	}
	if err := h.auth.EnsureOrganizerOwnsEvent(c.Request().Context(), req.EventID, scannerUserID); err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return jsonError(c, http.StatusForbidden, "FORBIDDEN", "scanner is not allowed")
		}
		if errors.Is(err, repository.ErrNotFound) {
			return jsonError(c, http.StatusNotFound, "NOT_FOUND", "event not found")
		}
		h.log.Error("ScanHandler.CheckIn: authorization error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}

	// Enforce require_qr_for_entry: QR scanning is only available when the
	// organizer has explicitly enabled QR-based admission for the event.
	// Default when no policy row exists: require_qr_for_entry = false → blocked.
	checkInPolicy, pErr := h.auth.GetAttendancePolicy(c.Request().Context(), req.EventID)
	if pErr != nil && !errors.Is(pErr, repository.ErrNotFound) {
		h.log.Error("ScanHandler.CheckIn: policy fetch error", zap.Error(pErr))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	if errors.Is(pErr, repository.ErrNotFound) {
		checkInPolicy = nil
	}
	if checkInPolicy == nil || !checkInPolicy.RequireQRForEntry {
		return jsonError(c, http.StatusForbidden, "POLICY_BLOCK", "QR admission is not enabled for this event")
	}

	outcome, err := h.svc.CheckIn(c.Request().Context(), req.Token, req.EventID, scannerUserID, req.DeviceID, req.GateID)
	if err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return jsonError(c, http.StatusForbidden, "FORBIDDEN", "scanner is not allowed")
		}
		h.log.Error("ScanHandler.CheckIn: service error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	return c.JSON(http.StatusOK, map[string]any{
		"result":       outcome.Result,
		"credentialId": outcome.CredentialID,
		"eventId":      outcome.EventID,
		"status":       outcome.Status,
	})
}

// CheckInByBuyer handles POST /api/attendance/scan/check-in-user
// Scanner endpoint: checks in attendee by buyer user ID fallback.
func (h *ScanHandler) CheckInByBuyer(c echo.Context) error {
	var req struct {
		EventID     string  `json:"eventId"`
		BuyerUserID string  `json:"buyerUserId"`
		DeviceID    string  `json:"deviceId"`
		GateID      *string `json:"gateId"`
	}
	if err := c.Bind(&req); err != nil {
		return jsonError(c, http.StatusBadRequest, "INVALID_BODY", "invalid request body")
	}
	if req.EventID == "" || req.BuyerUserID == "" || req.DeviceID == "" {
		return jsonError(c, http.StatusBadRequest, "INVALID_BODY", "eventId, buyerUserId, and deviceId are required")
	}

	scannerUserID := middleware.RequireUserID(c)
	if scannerUserID == "" {
		return jsonError(c, http.StatusUnauthorized, "MISSING_USER_ID", "scanner identity required")
	}
	if err := h.auth.EnsureOrganizerOwnsEvent(c.Request().Context(), req.EventID, scannerUserID); err != nil {
		if errors.Is(err, service.ErrForbidden) {
			return jsonError(c, http.StatusForbidden, "FORBIDDEN", "scanner is not allowed")
		}
		if errors.Is(err, repository.ErrNotFound) {
			return jsonError(c, http.StatusNotFound, "NOT_FOUND", "event not found")
		}
		h.log.Error("ScanHandler.CheckInByBuyer: authorization error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}

	// Fetch the event attendance policy before delegating to the scan service.
	// A nil policy (no row) is passed as-is; the service defaults to blocked.
	policy, perr := h.auth.GetAttendancePolicy(c.Request().Context(), req.EventID)
	if perr != nil && !errors.Is(perr, repository.ErrNotFound) {
		h.log.Error("ScanHandler.CheckInByBuyer: policy fetch error", zap.Error(perr))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	if errors.Is(perr, repository.ErrNotFound) {
		policy = nil // explicit: no row → service will default to blocked
	}

	outcome, err := h.svc.CheckInByBuyer(
		c.Request().Context(),
		req.EventID,
		req.BuyerUserID,
		scannerUserID,
		req.DeviceID,
		req.GateID,
		policy,
	)
	if err != nil {
		if errors.Is(err, service.ErrPolicyBlock) {
			return jsonError(c, http.StatusForbidden, "POLICY_BLOCK", "manual override disabled by organizer policy")
		}
		if errors.Is(err, service.ErrForbidden) {
			return jsonError(c, http.StatusForbidden, "FORBIDDEN", "scanner is not allowed")
		}
		h.log.Error("ScanHandler.CheckInByBuyer: service error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	return c.JSON(http.StatusOK, map[string]any{
		"result":       outcome.Result,
		"credentialId": outcome.CredentialID,
		"eventId":      outcome.EventID,
		"status":       outcome.Status,
	})
}
