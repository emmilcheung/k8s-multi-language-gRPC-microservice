package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/acme/venue-service/internal/repository"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// PlanHandler handles seating plan lifecycle endpoints.
type PlanHandler struct {
	planRepo repository.PlanRepository
	log      *zap.Logger
}

// NewPlanHandler creates a new PlanHandler.
func NewPlanHandler(planRepo repository.PlanRepository, log *zap.Logger) *PlanHandler {
	return &PlanHandler{planRepo: planRepo, log: log}
}

// RegisterRoutes attaches seating plan routes to the given Echo group.
func (h *PlanHandler) RegisterRoutes(g *echo.Group) {
	g.POST("", h.Create)
	g.GET("/:id", h.Get)
	g.PUT("/:id", h.Update)
	g.PATCH("/:id/layout", h.SaveLayout)
	g.POST("/:id/attach-ticket", h.AttachTicket)
	g.POST("/:id/activate", h.Activate)
}

// createPlanRequest is the request body for creating a seating plan.
type createPlanRequest struct {
	VenueID          string `json:"venueId"`
	Name             string `json:"name"`
	HoldTTLSec       int    `json:"holdTtlSec"`
	MaxSeatsPerOrder int    `json:"maxSeatsPerOrder"`
}

// updatePlanRequest is the request body for updating a seating plan.
type updatePlanRequest struct {
	Name             string `json:"name"`
	HoldTTLSec       int    `json:"holdTtlSec"`
	MaxSeatsPerOrder int    `json:"maxSeatsPerOrder"`
}

// attachTicketRequest is the request body for attaching a ticket to a plan.
type attachTicketRequest struct {
	TicketID        string `json:"ticketId"`
	ExpectedVersion int    `json:"expectedVersion"`
}

// activatePlanRequest is the request body for activating a plan.
type activatePlanRequest struct {
	ExpectedVersion int `json:"expectedVersion"`
}

// Create handles POST /api/seating-plans.
func (h *PlanHandler) Create(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	var req createPlanRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.VenueID == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("venueId is required"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}

	p := &repository.SeatingPlan{
		VenueID:          req.VenueID,
		OrganizerID:      organizerID,
		Name:             req.Name,
		HoldTTLSec:       req.HoldTTLSec,
		MaxSeatsPerOrder: req.MaxSeatsPerOrder,
	}

	if err := h.planRepo.Create(c.Request().Context(), p); err != nil {
		h.log.Error("plan create failed", zap.Error(err))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusCreated, p)
}

// Get handles GET /api/seating-plans/:id.
func (h *PlanHandler) Get(c echo.Context) error {
	id := c.Param("id")

	p, err := h.planRepo.FindByID(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("plan get failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, p)
}

// Update handles PUT /api/seating-plans/:id.
func (h *PlanHandler) Update(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	id := c.Param("id")

	var req updatePlanRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}

	p := &repository.SeatingPlan{
		ID:               id,
		OrganizerID:      organizerID,
		Name:             req.Name,
		HoldTTLSec:       req.HoldTTLSec,
		MaxSeatsPerOrder: req.MaxSeatsPerOrder,
	}

	if err := h.planRepo.Update(c.Request().Context(), p); err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("plan update failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, p)
}

// AttachTicket handles POST /api/seating-plans/:id/attach-ticket.
func (h *PlanHandler) AttachTicket(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	id := c.Param("id")

	var req attachTicketRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.TicketID == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("ticketId is required"))
	}

	// Validate ownership before mutating.
	existing, err := h.planRepo.FindByID(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("plan attach-ticket lookup failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	if existing.OrganizerID != organizerID {
		return c.JSON(http.StatusForbidden, errorResponse("not the plan owner"))
	}

	version := req.ExpectedVersion
	if version == 0 {
		version = existing.Version
	}

	if err := h.planRepo.AttachTicket(c.Request().Context(), id, req.TicketID, version); err != nil {
		switch {
		case errors.Is(err, repository.ErrPlanNotFound):
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		case errors.Is(err, repository.ErrPlanAlreadyActive):
			return c.JSON(http.StatusConflict, errorResponse("plan is already active"))
		case errors.Is(err, repository.ErrVersionConflict):
			return c.JSON(http.StatusConflict, errorResponse("version conflict: plan was modified concurrently"))
		default:
			h.log.Error("plan attach-ticket failed", zap.Error(err), zap.String("planId", id))
			return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
		}
	}

	// Return the updated plan.
	updated, err := h.planRepo.FindByID(c.Request().Context(), id)
	if err != nil {
		h.log.Error("plan attach-ticket re-fetch failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, updated)
}

// Activate handles POST /api/seating-plans/:id/activate.
func (h *PlanHandler) Activate(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	id := c.Param("id")

	var req activatePlanRequest
	// Bind is optional here — expectedVersion may come as query param too.
	_ = c.Bind(&req)

	// Support ?version= query param as fallback.
	if req.ExpectedVersion == 0 {
		if vStr := c.QueryParam("version"); vStr != "" {
			v, parseErr := strconv.Atoi(vStr)
			if parseErr == nil {
				req.ExpectedVersion = v
			}
		}
	}

	// Validate ownership.
	existing, err := h.planRepo.FindByID(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("plan activate lookup failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	if existing.OrganizerID != organizerID {
		return c.JSON(http.StatusForbidden, errorResponse("not the plan owner"))
	}

	version := req.ExpectedVersion
	if version == 0 {
		version = existing.Version
	}

	if err := h.planRepo.Activate(c.Request().Context(), id, version); err != nil {
		switch {
		case errors.Is(err, repository.ErrPlanNotFound):
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		case errors.Is(err, repository.ErrPlanAlreadyActive):
			return c.JSON(http.StatusConflict, errorResponse("plan is already active"))
		case errors.Is(err, repository.ErrPlanNotAttached):
			return c.JSON(http.StatusUnprocessableEntity, errorResponse("plan must be attached to a ticket before activation"))
		case errors.Is(err, repository.ErrPlanHasNoSections):
			return c.JSON(http.StatusUnprocessableEntity, errorResponse("plan must have at least one section before activation"))
		case errors.Is(err, repository.ErrVersionConflict):
			return c.JSON(http.StatusConflict, errorResponse("version conflict: plan was modified concurrently"))
		default:
			h.log.Error("plan activate failed", zap.Error(err), zap.String("planId", id))
			return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
		}
	}

	updated, err := h.planRepo.FindByID(c.Request().Context(), id)
	if err != nil {
		h.log.Error("plan activate re-fetch failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, updated)
}

// saveLayoutRequest is the request body for PATCH /api/seating-plans/:id/layout.
type saveLayoutRequest struct {
	LayoutJSON json.RawMessage `json:"layoutJson"`
}

// SaveLayout handles PATCH /api/seating-plans/:id/layout.
// Persists the free-form 2-D canvas layout blob for a draft seating plan.
// Only the plan owner may call this endpoint and only while the plan is in draft.
func (h *PlanHandler) SaveLayout(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	id := c.Param("id")

	var req saveLayoutRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if len(req.LayoutJSON) == 0 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("layoutJson is required"))
	}

	if err := h.planRepo.SaveLayout(c.Request().Context(), id, organizerID, req.LayoutJSON); err != nil {
		switch {
		case errors.Is(err, repository.ErrPlanNotFound):
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		case errors.Is(err, repository.ErrPlanAlreadyActive):
			return c.JSON(http.StatusConflict, errorResponse("layout can only be saved while plan is in draft"))
		default:
			h.log.Error("plan save-layout failed", zap.Error(err), zap.String("planId", id))
			return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
		}
	}

	updated, err := h.planRepo.FindByID(c.Request().Context(), id)
	if err != nil {
		h.log.Error("plan save-layout re-fetch failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, updated)
}
