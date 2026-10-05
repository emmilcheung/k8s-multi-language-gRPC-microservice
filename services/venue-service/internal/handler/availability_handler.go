package handler

import (
	"errors"
	"net/http"
	"regexp"

	"github.com/acme/venue-service/internal/repository"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// AvailabilityHandler serves the seat counts the waiting room uses to tell
// "paused, seats may come back" from "sold out".
type AvailabilityHandler struct {
	reader repository.AvailabilityReader
	log    *zap.Logger
}

// NewAvailabilityHandler creates a new AvailabilityHandler.
func NewAvailabilityHandler(reader repository.AvailabilityReader, log *zap.Logger) *AvailabilityHandler {
	return &AvailabilityHandler{reader: reader, log: log}
}

// RegisterRoutes attaches the route to the root router, deliberately outside
// /api: Kong only forwards /api paths, so this stays cluster-internal.
func (h *AvailabilityHandler) RegisterRoutes(e *echo.Echo) {
	e.GET("/internal/tickets/:ticketId/availability", h.Get)
}

// Get handles GET /internal/tickets/:ticketId/availability.
// No authentication: the response is two counts, and the route is not exposed
// through the gateway.
func (h *AvailabilityHandler) Get(c echo.Context) error {
	ticketID := c.Param("ticketId")
	if !uuidPattern.MatchString(ticketID) {
		return c.JSON(http.StatusBadRequest, errorResponse("ticketId must be a UUID"))
	}

	a, err := h.reader.TicketAvailability(c.Request().Context(), ticketID)
	if err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("ticket has no active seating plan"))
		}
		h.log.Error("ticket availability failed", zap.Error(err), zap.String("ticketId", ticketID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	return c.JSON(http.StatusOK, map[string]int{"available": a.Available, "held": a.Held})
}
