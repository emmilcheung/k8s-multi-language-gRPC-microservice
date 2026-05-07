package handler

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// ScanHandler handles scanner REST endpoints.
// Stub implementation: business logic (token verification, scan recording) is wired in WS2.
type ScanHandler struct {
	log *zap.Logger
}

// NewScanHandler creates a new ScanHandler.
func NewScanHandler(log *zap.Logger) *ScanHandler {
	return &ScanHandler{log: log}
}

// ValidateToken handles POST /api/attendance/scan/validate
// Scanner endpoint: validates a QR token without recording admission.
// Stub: returns 501 until WS2 implements token verification logic.
func (h *ScanHandler) ValidateToken(c echo.Context) error {
	h.log.Info("ScanHandler.ValidateToken: not yet implemented (WS2)")
	return jsonError(c, http.StatusNotImplemented, "NOT_IMPLEMENTED", "scan validate is not yet implemented")
}

// CheckIn handles POST /api/attendance/scan/check-in
// Scanner endpoint: verifies and records a check-in scan event.
// Stub: returns 501 until WS2 implements admission logic.
func (h *ScanHandler) CheckIn(c echo.Context) error {
	h.log.Info("ScanHandler.CheckIn: not yet implemented (WS2)")
	return jsonError(c, http.StatusNotImplemented, "NOT_IMPLEMENTED", "scan check-in is not yet implemented")
}
