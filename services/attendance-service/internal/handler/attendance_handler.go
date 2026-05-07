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

// AttendanceHandler handles buyer and organizer attendance REST endpoints.
type AttendanceHandler struct {
	svc service.AttendanceService
	log *zap.Logger
}

// NewAttendanceHandler creates a new AttendanceHandler.
func NewAttendanceHandler(svc service.AttendanceService, log *zap.Logger) *AttendanceHandler {
	return &AttendanceHandler{svc: svc, log: log}
}

// GetTicket handles GET /api/attendance/tickets/:ticketId
// Buyer endpoint: returns admission pass for a ticket.
func (h *AttendanceHandler) GetTicket(c echo.Context) error {
	ticketID := c.Param("ticketId")
	if ticketID == "" {
		return jsonError(c, http.StatusBadRequest, "INVALID_PARAM", "ticketId is required")
	}

	orderID := c.QueryParam("orderId")
	var orderIDPtr *string
	if orderID != "" {
		orderIDPtr = &orderID
	}

	cred, err := h.svc.GetAdmissionPass(c.Request().Context(), ticketID, orderIDPtr)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return jsonError(c, http.StatusNotFound, "NOT_FOUND", "admission pass not found")
		}
		h.log.Error("GetTicket: service error", zap.Error(err), zap.String("ticketId", ticketID))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}

	return c.JSON(http.StatusOK, mapCredentialToResponse(cred))
}

// GetEventSettings handles GET /api/attendance/events/:eventId/settings
// Organizer endpoint: returns attendance policy for an event.
func (h *AttendanceHandler) GetEventSettings(c echo.Context) error {
	eventID := c.Param("eventId")
	if eventID == "" {
		return jsonError(c, http.StatusBadRequest, "INVALID_PARAM", "eventId is required")
	}

	policy, err := h.svc.GetAttendancePolicy(c.Request().Context(), eventID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			// Return a default policy when none is configured.
			return c.JSON(http.StatusOK, map[string]interface{}{
				"eventId":             eventID,
				"requireQrForEntry":   true,
				"allowManualOverride": false,
			})
		}
		h.log.Error("GetEventSettings: service error", zap.Error(err), zap.String("eventId", eventID))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"eventId":             policy.EventID,
		"requireQrForEntry":   policy.RequireQRForEntry,
		"allowManualOverride": policy.AllowManualOverride,
	})
}

// PatchEventSettings handles PATCH /api/attendance/events/:eventId/settings
// Organizer endpoint: creates or updates attendance policy for an event.
func (h *AttendanceHandler) PatchEventSettings(c echo.Context) error {
	eventID := c.Param("eventId")
	if eventID == "" {
		return jsonError(c, http.StatusBadRequest, "INVALID_PARAM", "eventId is required")
	}

	var body struct {
		RequireQRForEntry   *bool `json:"requireQrForEntry"`
		AllowManualOverride *bool `json:"allowManualOverride"`
	}
	if err := c.Bind(&body); err != nil {
		return jsonError(c, http.StatusBadRequest, "INVALID_BODY", "invalid request body")
	}

	// Fetch existing or use defaults.
	policy, err := h.svc.GetAttendancePolicy(c.Request().Context(), eventID)
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		h.log.Error("PatchEventSettings: fetch error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	if policy == nil {
		organizerID := middleware.RequireUserID(c)
		if organizerID == "" {
			return jsonError(c, http.StatusUnauthorized, "MISSING_USER_ID", "organizer identity required to create a policy")
		}
		policy = &repository.AttendancePolicy{
			EventID:             eventID,
			OrganizerID:         organizerID,
			RequireQRForEntry:   true,
			AllowManualOverride: false,
		}
	}

	if body.RequireQRForEntry != nil {
		policy.RequireQRForEntry = *body.RequireQRForEntry
	}
	if body.AllowManualOverride != nil {
		policy.AllowManualOverride = *body.AllowManualOverride
	}

	if err := h.svc.UpsertAttendancePolicy(c.Request().Context(), policy); err != nil {
		h.log.Error("PatchEventSettings: upsert error", zap.Error(err))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"eventId":             policy.EventID,
		"requireQrForEntry":   policy.RequireQRForEntry,
		"allowManualOverride": policy.AllowManualOverride,
	})
}

// GetEventSummary handles GET /api/attendance/events/:eventId/summary
// Organizer endpoint: returns attendance summary for an event.
func (h *AttendanceHandler) GetEventSummary(c echo.Context) error {
	eventID := c.Param("eventId")
	if eventID == "" {
		return jsonError(c, http.StatusBadRequest, "INVALID_PARAM", "eventId is required")
	}

	summary, err := h.svc.GetAttendanceSummary(c.Request().Context(), eventID)
	if err != nil {
		h.log.Error("GetEventSummary: service error", zap.Error(err), zap.String("eventId", eventID))
		return jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"eventId":        summary.EventID,
		"totalAdmitted":  summary.TotalAdmitted,
		"totalDenied":    summary.TotalDenied,
		"totalCheckedIn": summary.TotalCheckedIn,
	})
}

func mapCredentialToResponse(c *repository.AdmissionCredential) map[string]interface{} {
	resp := map[string]interface{}{
		"id":       c.ID,
		"ticketId": c.TicketID,
		"orderId":  c.OrderID,
		"eventId":  c.EventID,
		"status":   string(c.Status),
		"issuedAt": c.IssuedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	if c.UsedAt != nil {
		resp["usedAt"] = c.UsedAt.Format("2006-01-02T15:04:05Z07:00")
	}
	return resp
}

// jsonError returns a structured JSON error response aligned with docs/03-api-design.md.
func jsonError(c echo.Context, status int, code, message string) error {
	return c.JSON(status, map[string]interface{}{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}
