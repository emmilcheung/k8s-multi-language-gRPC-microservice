package handler

import (
	"errors"
	"net/http"

	"github.com/acme/venue-service/internal/repository"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// VenueSectionHandler handles template section CRUD under /api/venues/:venueId/sections.
type VenueSectionHandler struct {
	venueRepo     repository.VenueRepository
	vsSectionRepo repository.VenueSectionRepository
	log           *zap.Logger
}

// NewVenueSectionHandler creates a new VenueSectionHandler.
func NewVenueSectionHandler(
	venueRepo repository.VenueRepository,
	vsSectionRepo repository.VenueSectionRepository,
	log *zap.Logger,
) *VenueSectionHandler {
	return &VenueSectionHandler{
		venueRepo:     venueRepo,
		vsSectionRepo: vsSectionRepo,
		log:           log,
	}
}

// RegisterRoutes attaches venue section routes to /api/venues/:venueId.
func (h *VenueSectionHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/sections", h.List)
	g.POST("/sections", h.Create)
	g.DELETE("/sections/:sectionId", h.Delete)
}

type createVenueSectionRequest struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	RowCount     int    `json:"rowCount"`
	ColumnCount  int    `json:"columnCount"`
	DisplayOrder int    `json:"displayOrder"`
}

// List handles GET /api/venues/:venueId/sections.
func (h *VenueSectionHandler) List(c echo.Context) error {
	venueID := c.Param("venueId")

	sections, err := h.vsSectionRepo.ListByVenue(c.Request().Context(), venueID)
	if err != nil {
		h.log.Error("venue section list failed", zap.Error(err), zap.String("venueId", venueID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	if sections == nil {
		sections = []*repository.VenueSection{}
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"sections": sections})
}

// Create handles POST /api/venues/:venueId/sections.
func (h *VenueSectionHandler) Create(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	venueID := c.Param("venueId")

	// Ownership check — only the venue owner may add template sections.
	venue, err := h.venueRepo.FindByID(c.Request().Context(), venueID)
	if err != nil {
		if errors.Is(err, repository.ErrVenueNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("venue not found"))
		}
		h.log.Error("venue section create: venue lookup failed", zap.Error(err))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	if venue.OrganizerID != organizerID {
		return c.JSON(http.StatusForbidden, errorResponse("not the venue owner"))
	}

	var req createVenueSectionRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}
	if req.Type != "seated" && req.Type != "ga" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("type must be 'seated' or 'ga'"))
	}
	if req.Type == "seated" && (req.RowCount < 1 || req.ColumnCount < 1) {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("seated sections require rowCount >= 1 and columnCount >= 1"))
	}
	if req.Type == "ga" && req.ColumnCount < 1 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("GA sections require columnCount (capacity) >= 1"))
	}

	vs := &repository.VenueSection{
		VenueID:      venueID,
		Name:         req.Name,
		Type:         repository.SectionType(req.Type),
		RowCount:     req.RowCount,
		ColumnCount:  req.ColumnCount,
		DisplayOrder: req.DisplayOrder,
	}

	if err := h.vsSectionRepo.Create(c.Request().Context(), vs); err != nil {
		h.log.Error("venue section create failed", zap.Error(err), zap.String("venueId", venueID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusCreated, vs)
}

// Delete handles DELETE /api/venues/:venueId/sections/:sectionId.
func (h *VenueSectionHandler) Delete(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	venueID := c.Param("venueId")
	sectionID := c.Param("sectionId")

	// Ownership check.
	venue, err := h.venueRepo.FindByID(c.Request().Context(), venueID)
	if err != nil {
		if errors.Is(err, repository.ErrVenueNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("venue not found"))
		}
		h.log.Error("venue section delete: venue lookup failed", zap.Error(err))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	if venue.OrganizerID != organizerID {
		return c.JSON(http.StatusForbidden, errorResponse("not the venue owner"))
	}

	if err := h.vsSectionRepo.Delete(c.Request().Context(), sectionID, venueID); err != nil {
		if errors.Is(err, repository.ErrSectionNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("section not found"))
		}
		h.log.Error("venue section delete failed", zap.Error(err), zap.String("sectionId", sectionID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.NoContent(http.StatusNoContent)
}
