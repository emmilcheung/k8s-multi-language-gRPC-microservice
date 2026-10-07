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

// VenueHandler handles venue CRUD endpoints.
type VenueHandler struct {
	repo      repository.VenueRepository
	validator *security.UserIDSignatureValidator
	access    *Access
	log       *zap.Logger
}

// NewVenueHandler creates a new VenueHandler.
func NewVenueHandler(repo repository.VenueRepository, validator *security.UserIDSignatureValidator, log *zap.Logger) *VenueHandler {
	return &VenueHandler{repo: repo, validator: validator, access: legacyAccess(log), log: log}
}

// WithAccess sends organizer writes through the permission check.
func (h *VenueHandler) WithAccess(a *Access) *VenueHandler {
	h.access = a
	return h
}

// RegisterRoutes attaches venue routes to the given Echo group.
func (h *VenueHandler) RegisterRoutes(g *echo.Group) {
	g.POST("", h.Create)
	g.GET("", h.List)
	g.GET("/:id", h.Get)
	g.PUT("/:id", h.Update)
}

// createVenueRequest is the request body for creating a venue.
type createVenueRequest struct {
	Name     string  `json:"name"`
	Capacity int     `json:"capacity"`
	Timezone string  `json:"timezone"`
	Address  *string `json:"address"`
}

// updateVenueRequest is the request body for updating a venue.
type updateVenueRequest struct {
	Name     string  `json:"name"`
	Capacity int     `json:"capacity"`
	Timezone string  `json:"timezone"`
	Address  *string `json:"address"`
}

// Create handles POST /api/venues.
// The organizer identity is derived from the Kong-injected X-User-Id header.
// X-User-Id-Sig must be valid; missing or invalid signatures result in 401.
func (h *VenueHandler) Create(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	var req createVenueRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}
	if req.Capacity <= 0 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("capacity must be positive"))
	}
	if req.Timezone == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("timezone is required"))
	}

	address := ""
	if req.Address != nil {
		address = *req.Address
	}

	v := &repository.Venue{
		OrganizerID: organizerID,
		Name:        req.Name,
		Capacity:    req.Capacity,
		Timezone:    req.Timezone,
		Address:     address,
	}

	ctx := c.Request().Context()
	caller, acting, err := h.access.Caller(c, organizerID)
	if handled, e := h.access.Fail(c, h.log, err, 0, ""); handled {
		return e
	}
	createdBy, err := h.access.org.AuthorizeVenueCreate(ctx, caller, acting)
	if handled, e := h.access.Fail(c, h.log, err, 0, ""); handled {
		return e
	}
	v.CreatedByAccountID = createdBy

	err = h.access.org.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, caller.UserID, createdBy, service.ActionVenueCreate, "venue:"+v.ID, nil, service.VenueFields(v))
	}, func(ctx context.Context) error { return h.repo.Create(ctx, v) })
	if err != nil {
		h.log.Error("venue create failed", zap.Error(err))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusCreated, v)
}

// Get handles GET /api/venues/:id.
func (h *VenueHandler) Get(c echo.Context) error {
	id := c.Param("id")

	v, err := h.repo.FindByID(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrVenueNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("venue not found"))
		}
		h.log.Error("venue get failed", zap.Error(err), zap.String("venueId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, v)
}

// List handles GET /api/venues.
// Returns all venues for the requesting organizer (X-User-Id).
// X-User-Id-Sig must be valid; missing or invalid signatures result in 401.
func (h *VenueHandler) List(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	venues, err := h.repo.ListByOrganizer(c.Request().Context(), organizerID)
	if err != nil {
		h.log.Error("venue list failed", zap.Error(err))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	// Return empty array rather than null.
	if venues == nil {
		venues = []*repository.Venue{}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"venues": venues})
}

// Update handles PUT /api/venues/:id.
// Only the owning organizer may update the venue (enforced by repo WHERE clause).
// X-User-Id-Sig must be valid; missing or invalid signatures result in 401.
func (h *VenueHandler) Update(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	id := c.Param("id")

	var req updateVenueRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}
	if req.Capacity <= 0 {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("capacity must be positive"))
	}
	if req.Timezone == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("timezone is required"))
	}

	address := ""
	if req.Address != nil {
		address = *req.Address
	}

	ctx := c.Request().Context()
	existing, err := h.repo.FindByID(ctx, id)
	if err != nil {
		if errors.Is(err, repository.ErrVenueNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("venue not found"))
		}
		h.log.Error("venue update lookup failed", zap.Error(err), zap.String("venueId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	caller, acting, err := h.access.Caller(c, organizerID)
	if handled, e := h.access.Fail(c, h.log, err, 0, ""); handled {
		return e
	}
	actorAccount, err := h.access.org.AuthorizeVenueEdit(ctx, caller, acting, existing)
	if handled, e := h.access.Fail(c, h.log, err, http.StatusNotFound, "venue not found"); handled {
		return e
	}

	// The stored owner is passed so that a venue team member, who is not the
	// creator, passes the repository's ownership guard once authorized.
	v := &repository.Venue{
		ID:                 id,
		OrganizerID:        existing.OrganizerID,
		Name:               req.Name,
		Capacity:           req.Capacity,
		Timezone:           req.Timezone,
		Address:            address,
		Status:             existing.Status,
		CreatedByAccountID: existing.CreatedByAccountID,
	}

	err = h.access.org.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, caller.UserID, actorAccount, service.ActionVenueUpdate, "venue:"+id, service.VenueFields(existing), service.VenueFields(v))
	}, func(ctx context.Context) error { return h.repo.Update(ctx, v) })
	if err != nil {
		if errors.Is(err, repository.ErrVenueNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("venue not found"))
		}
		h.log.Error("venue update failed", zap.Error(err), zap.String("venueId", id))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusOK, v)
}

// errorResponse returns a standard JSON error envelope.
func errorResponse(msg string) map[string]string {
	return map[string]string{"error": msg}
}
