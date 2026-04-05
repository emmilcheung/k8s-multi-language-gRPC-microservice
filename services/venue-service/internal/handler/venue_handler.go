package handler

import (
	"errors"
	"net/http"

	"github.com/acme/venue-service/internal/repository"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// VenueHandler handles venue CRUD endpoints.
type VenueHandler struct {
	repo repository.VenueRepository
	log  *zap.Logger
}

// NewVenueHandler creates a new VenueHandler.
func NewVenueHandler(repo repository.VenueRepository, log *zap.Logger) *VenueHandler {
	return &VenueHandler{repo: repo, log: log}
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
	Name     string `json:"name"`
	Capacity int    `json:"capacity"`
	Timezone string `json:"timezone"`
	Address  *string `json:"address"`
}

// updateVenueRequest is the request body for updating a venue.
type updateVenueRequest struct {
	Name     string `json:"name"`
	Capacity int    `json:"capacity"`
	Timezone string `json:"timezone"`
	Address  *string `json:"address"`
}

// Create handles POST /api/venues.
// The organizer identity is derived from the Kong-injected X-User-Id header.
func (h *VenueHandler) Create(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
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

	if err := h.repo.Create(c.Request().Context(), v); err != nil {
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
func (h *VenueHandler) List(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
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
func (h *VenueHandler) Update(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
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

	v := &repository.Venue{
		ID:          id,
		OrganizerID: organizerID,
		Name:        req.Name,
		Capacity:    req.Capacity,
		Timezone:    req.Timezone,
		Address:     address,
	}

	if err := h.repo.Update(c.Request().Context(), v); err != nil {
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
