package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// PlanHandler handles seating plan lifecycle endpoints.
type PlanHandler struct {
	planRepo    repository.PlanRepository
	sectionRepo repository.SectionRepository
	validator   *security.UserIDSignatureValidator
	log         *zap.Logger
}

// NewPlanHandler creates a new PlanHandler.
func NewPlanHandler(planRepo repository.PlanRepository, sectionRepo repository.SectionRepository, validator *security.UserIDSignatureValidator, log *zap.Logger) *PlanHandler {
	return &PlanHandler{planRepo: planRepo, sectionRepo: sectionRepo, validator: validator, log: log}
}

// RegisterRoutes attaches seating plan routes to the given Echo group.
func (h *PlanHandler) RegisterRoutes(g *echo.Group) {
	g.GET("", h.List)
	g.POST("", h.Create)
	g.GET("/:id", h.Get)
	g.PUT("/:id", h.Update)
	g.PATCH("/:id/layout", h.SaveLayout)
	g.POST("/:id/activate", h.Activate)
	g.POST("/:id/deactivate", h.Deactivate)
}

// createPlanRequest is the request body for creating a seating plan.
type createPlanRequest struct {
	VenueID          string `json:"venueId"`
	TicketID         string `json:"ticketId"`
	Name             string `json:"name"`
	MaxSeatsPerOrder int    `json:"maxSeatsPerOrder"`
	AssignmentMode   string `json:"assignmentMode"`
	PricingMode      string `json:"pricingMode"`
}

// updatePlanRequest is the request body for updating a seating plan.
type updatePlanRequest struct {
	Name             string `json:"name"`
	MaxSeatsPerOrder int    `json:"maxSeatsPerOrder"`
	AssignmentMode   string `json:"assignmentMode"`
	PricingMode      string `json:"pricingMode"`
}

// activatePlanRequest is the request body for activating a plan.
type activatePlanRequest struct {
	ExpectedVersion int `json:"expectedVersion"`
}

// List handles GET /api/seating-plans?ticketId=<ticketId> or ?venueId=<venueId>.
// When ticketId is provided, returns plans for that ticket (primary).
// Falls back to venueId filter if ticketId is not provided.
// Returns all seating plans belonging to the authenticated organizer.
func (h *PlanHandler) List(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	ticketID := c.QueryParam("ticketId")
	venueID := c.QueryParam("venueId")

	var plans []*repository.SeatingPlan
	var err error

	if ticketID != "" {
		// Primary: filter by ticket (organizer-scoped)
		plans, err = h.planRepo.ListByTicket(c.Request().Context(), ticketID, organizerID)
		if err != nil {
			h.log.Error("plan list by ticket failed", zap.Error(err), zap.String("ticketId", ticketID))
			return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
		}
	} else if venueID != "" {
		// Fallback: filter by venue (organizer-scoped)
		plans, err = h.planRepo.ListByVenue(c.Request().Context(), venueID, organizerID)
		if err != nil {
			h.log.Error("plan list by venue failed", zap.Error(err), zap.String("venueId", venueID))
			return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
		}
	} else {
		// Neither provided: error
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("either ticketId or venueId query parameter is required"))
	}

	// Always return an array, never null.
	if plans == nil {
		plans = []*repository.SeatingPlan{}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"plans": plans})
}

// Create handles POST /api/seating-plans.
func (h *PlanHandler) Create(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	var req createPlanRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.VenueID == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("venueId is required"))
	}
	if req.TicketID == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("ticketId is required"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}

	p := &repository.SeatingPlan{
		VenueID:          req.VenueID,
		TicketID:         req.TicketID,
		OrganizerID:      organizerID,
		Name:             req.Name,
		MaxSeatsPerOrder: req.MaxSeatsPerOrder,
		AssignmentMode:   req.AssignmentMode,
		PricingMode:      req.PricingMode,
	}

	if err := h.planRepo.Create(c.Request().Context(), p); err != nil {
		h.log.Error("plan create failed", zap.Error(err))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	// Auto-provision sections from the venue template.
	// This is best-effort: if the venue has no template sections yet the plan
	// remains empty and the organiser must define venue sections first.
	if _, provErr := h.sectionRepo.ProvisionFromVenue(c.Request().Context(), p.ID, req.VenueID); provErr != nil {
		h.log.Warn("plan auto-provision failed (plan created, sections missing)",
			zap.Error(provErr), zap.String("planId", p.ID), zap.String("venueId", req.VenueID))
		// Do not fail the request — plan creation succeeded.
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

	sections, err := h.sectionRepo.ListSectionsByPlan(c.Request().Context(), id)
	if err != nil {
		h.log.Error("plan get sections failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	p.Sections = sections

	// Compute total capacity: sum of (rowCount * columnCount) for all sections.
	totalCapacity := 0
	for _, section := range sections {
		totalCapacity += section.RowCount * section.ColumnCount
	}
	p.TotalCapacity = totalCapacity

	return c.JSON(http.StatusOK, p)
}

// Update handles PUT /api/seating-plans/:id.
func (h *PlanHandler) Update(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
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
		MaxSeatsPerOrder: req.MaxSeatsPerOrder,
		AssignmentMode:   req.AssignmentMode,
		PricingMode:      req.PricingMode,
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

// Activate handles POST /api/seating-plans/:id/activate.
func (h *PlanHandler) Activate(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
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

	// Validate that plan has at least one seat: compute total capacity.
	sections, err := h.sectionRepo.ListSectionsByPlan(c.Request().Context(), id)
	if err != nil {
		h.log.Error("plan activate sections lookup failed", zap.Error(err), zap.String("planId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	// Validate that GA sections only exist in single-price plans.
	if existing.PricingMode != "single" {
		for _, section := range sections {
			if section.Type == repository.SectionTypeGA {
				return c.JSON(http.StatusBadRequest, errorResponse("GA sections are not allowed in section/seat pricing plans. Create a separate GA ticket instead."))
			}
		}
	}

	totalCapacity := 0
	for _, section := range sections {
		totalCapacity += section.RowCount * section.ColumnCount
	}
	if totalCapacity == 0 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("plan must have at least one seat before activation"))
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

// Deactivate handles POST /api/seating-plans/:id/deactivate.
// Transitions an active plan to inactive, stopping new seat holds and purchases.
func (h *PlanHandler) Deactivate(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	id := c.Param("id")

	if err := h.planRepo.Deactivate(c.Request().Context(), id, organizerID); err != nil {
		switch {
		case errors.Is(err, repository.ErrPlanNotFound):
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		case errors.Is(err, repository.ErrPlanNotActive):
			return c.JSON(http.StatusConflict, errorResponse("plan is not active"))
		default:
			h.log.Error("plan deactivate failed", zap.Error(err), zap.String("planId", id))
			return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
		}
	}

	updated, err := h.planRepo.FindByID(c.Request().Context(), id)
	if err != nil {
		h.log.Error("plan deactivate re-fetch failed", zap.Error(err), zap.String("planId", id))
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

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	id := c.Param("id")

	var req saveLayoutRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if len(req.LayoutJSON) == 0 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("layoutJson is required"))
	}

	// Validate layout size to prevent storage exhaustion attacks.
	const maxLayoutSize = 1_048_576 // 1 MB
	if len(req.LayoutJSON) > maxLayoutSize {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("layout JSON exceeds 1 MB limit"))
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
