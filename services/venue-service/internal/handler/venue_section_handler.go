package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/acme/venue-service/internal/audit"
	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/acme/venue-service/internal/service"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// VenueSectionHandler handles template section CRUD under /api/venues/:venueId/sections.
type VenueSectionHandler struct {
	venueRepo     repository.VenueRepository
	vsSectionRepo repository.VenueSectionRepository
	validator     *security.UserIDSignatureValidator
	access        *Access
	log           *zap.Logger
}

// NewVenueSectionHandler creates a new VenueSectionHandler.
func NewVenueSectionHandler(
	venueRepo repository.VenueRepository,
	vsSectionRepo repository.VenueSectionRepository,
	validator *security.UserIDSignatureValidator,
	log *zap.Logger,
) *VenueSectionHandler {
	return &VenueSectionHandler{
		venueRepo:     venueRepo,
		vsSectionRepo: vsSectionRepo,
		validator:     validator,
		access:        legacyAccess(log),
		log:           log,
	}
}

// WithAccess sends organizer writes through the permission check.
func (h *VenueSectionHandler) WithAccess(a *Access) *VenueSectionHandler {
	h.access = a
	return h
}

// authorize loads the venue and checks the caller may edit it. When it returns
// handled=true the response has been written.
func (h *VenueSectionHandler) authorize(c echo.Context, organizerID, venueID string) (caller string, actorAccount string, handled bool, err error) {
	ctx := c.Request().Context()
	venue, ferr := h.venueRepo.FindByID(ctx, venueID)
	if ferr != nil {
		if errors.Is(ferr, repository.ErrVenueNotFound) {
			return "", "", true, c.JSON(http.StatusNotFound, errorResponse("venue not found"))
		}
		h.log.Error("venue section: venue lookup failed", zap.Error(ferr))
		return "", "", true, c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	tc, acting, cerr := h.access.Caller(c, organizerID)
	if done, e := h.access.Fail(c, h.log, cerr, 0, ""); done {
		return "", "", true, e
	}
	account, aerr := h.access.org.AuthorizeVenueEdit(ctx, tc, acting, venue)
	if done, e := h.access.Fail(c, h.log, aerr, http.StatusForbidden, "not the venue owner"); done {
		return "", "", true, e
	}
	return tc.UserID, account, false, nil
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

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	venueID := c.Param("venueId")

	// Only the venue's editors may add template sections.
	actorUser, actorAccount, handled, err := h.authorize(c, organizerID, venueID)
	if handled {
		return err
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

	ctx := c.Request().Context()
	err = h.access.org.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, actorUser, actorAccount, service.ActionVenueSectionCreate, "venue_section:"+vs.ID, nil, venueSectionFields(vs))
	}, func(ctx context.Context) error { return h.vsSectionRepo.Create(ctx, vs) })
	if err != nil {
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

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	venueID := c.Param("venueId")
	sectionID := c.Param("sectionId")

	actorUser, actorAccount, handled, err := h.authorize(c, organizerID, venueID)
	if handled {
		return err
	}

	ctx := c.Request().Context()
	err = h.access.org.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, actorUser, actorAccount, service.ActionVenueSectionDelete, "venue_section:"+sectionID, map[string]any{"deleted": false}, map[string]any{"deleted": true})
	}, func(ctx context.Context) error { return h.vsSectionRepo.Delete(ctx, sectionID, venueID) })
	if err != nil {
		if errors.Is(err, repository.ErrSectionNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("section not found"))
		}
		h.log.Error("venue section delete failed", zap.Error(err), zap.String("sectionId", sectionID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.NoContent(http.StatusNoContent)
}

func venueSectionFields(vs *repository.VenueSection) map[string]any {
	return map[string]any{
		"venueId": vs.VenueID, "name": vs.Name, "type": string(vs.Type),
		"rowCount": vs.RowCount, "columnCount": vs.ColumnCount, "displayOrder": vs.DisplayOrder,
	}
}
