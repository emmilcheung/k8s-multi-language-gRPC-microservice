package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// SectionHandler handles section and price-tier endpoints inside a seating plan.
type SectionHandler struct {
	planRepo      repository.PlanRepository
	sectionRepo   repository.SectionRepository
	priceTierRepo PriceTierRepository
	validator     *security.UserIDSignatureValidator
	log           *zap.Logger
}

// PriceTierRepository is the narrow interface needed by SectionHandler.
type PriceTierRepository interface {
	Create(ctx context.Context, t *repository.PriceTier) error
	ListByPlan(ctx context.Context, planID string) ([]*repository.PriceTier, error)
}

// NewSectionHandler creates a new SectionHandler.
func NewSectionHandler(
	planRepo repository.PlanRepository,
	sectionRepo repository.SectionRepository,
	priceTierRepo PriceTierRepository,
	validator *security.UserIDSignatureValidator,
	log *zap.Logger,
) *SectionHandler {
	return &SectionHandler{
		planRepo:      planRepo,
		sectionRepo:   sectionRepo,
		priceTierRepo: priceTierRepo,
		validator:     validator,
		log:           log,
	}
}

// RegisterRoutes attaches section and price-tier routes to the given plan group.
// Expects to be registered under /api/seating-plans/:planId.
func (h *SectionHandler) RegisterRoutes(g *echo.Group) {
	g.POST("/sections", h.CreateSection)
	g.GET("/sections", h.ListSections)
	g.POST("/price-tiers", h.CreatePriceTier)
	g.GET("/price-tiers", h.ListPriceTiers)
}

// createSectionRequest is the request body for creating a section.
type createSectionRequest struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	RowCount    int    `json:"rowCount"`
	ColumnCount int    `json:"columnCount"`
	PriceTierID string `json:"priceTierId"` // optional; "" = use ticket default price
}

// createPriceTierRequest is the request body for creating a price tier.
type createPriceTierRequest struct {
	Name  string `json:"name"`
	Price string `json:"price"`
}

// CreateSection handles POST /api/seating-plans/:planId/sections.
func (h *SectionHandler) CreateSection(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	planID := c.Param("planId")

	// Ownership check.
	plan, err := h.planRepo.FindByID(c.Request().Context(), planID)
	if err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("section create: plan lookup failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	if plan.OrganizerID != organizerID {
		return c.JSON(http.StatusForbidden, errorResponse("not the plan owner"))
	}
	if plan.Status != repository.PlanStatusDraft {
		return c.JSON(http.StatusConflict, errorResponse("cannot add sections to an active or inactive plan"))
	}

	var req createSectionRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}
	if req.Type != string(repository.SectionTypeSeated) && req.Type != string(repository.SectionTypeGA) {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("type must be 'seated' or 'ga'"))
	}

	s := &repository.Section{
		PlanID:      planID,
		Name:        req.Name,
		Type:        repository.SectionType(req.Type),
		RowCount:    req.RowCount,
		ColumnCount: req.ColumnCount,
		PriceTierID: req.PriceTierID,
	}

	if err := h.sectionRepo.CreateSection(c.Request().Context(), s); err != nil {
		h.log.Error("section create failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	// Auto-generate seat rows for the new section.
	if err := h.sectionRepo.BulkInsertSeats(
		c.Request().Context(),
		s.ID, planID, req.Type, req.PriceTierID, req.RowCount, req.ColumnCount,
	); err != nil {
		h.log.Error("section seat generation failed", zap.Error(err),
			zap.String("sectionId", s.ID), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusCreated, s)
}

// ListSections handles GET /api/seating-plans/:planId/sections.
func (h *SectionHandler) ListSections(c echo.Context) error {
	planID := c.Param("planId")

	if _, err := h.planRepo.FindByID(c.Request().Context(), planID); err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("list sections: plan lookup failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	sections, err := h.sectionRepo.ListSectionsByPlan(c.Request().Context(), planID)
	if err != nil {
		h.log.Error("list sections failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	if sections == nil {
		sections = []*repository.Section{}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"sections": sections})
}

// CreatePriceTier handles POST /api/seating-plans/:planId/price-tiers.
func (h *SectionHandler) CreatePriceTier(c echo.Context) error {
	organizerID := c.Request().Header.Get("X-User-Id")
	if organizerID == "" {
		return c.JSON(http.StatusUnauthorized, errorResponse("missing X-User-Id header"))
	}

	signature := c.Request().Header.Get("X-User-Id-Sig")
	if !h.validator.IsValidSignature(organizerID, signature) {
		return c.JSON(http.StatusUnauthorized, errorResponse("invalid X-User-Id-Sig signature"))
	}

	planID := c.Param("planId")

	// Ownership check.
	plan, err := h.planRepo.FindByID(c.Request().Context(), planID)
	if err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("price-tier create: plan lookup failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	if plan.OrganizerID != organizerID {
		return c.JSON(http.StatusForbidden, errorResponse("not the plan owner"))
	}
	if plan.Status != repository.PlanStatusDraft {
		return c.JSON(http.StatusConflict, errorResponse("cannot add price tiers to an active or inactive plan"))
	}

	var req createPriceTierRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse("invalid request body"))
	}
	if req.Name == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("name is required"))
	}
	if req.Price == "" {
		return c.JSON(http.StatusUnprocessableEntity, errorResponse("price is required"))
	}

	t := &repository.PriceTier{
		PlanID: planID,
		Name:   req.Name,
		Price:  req.Price,
	}

	if err := h.priceTierRepo.Create(c.Request().Context(), t); err != nil {
		h.log.Error("price-tier create failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	return c.JSON(http.StatusCreated, t)
}

// ListPriceTiers handles GET /api/seating-plans/:planId/price-tiers.
func (h *SectionHandler) ListPriceTiers(c echo.Context) error {
	planID := c.Param("planId")

	if _, err := h.planRepo.FindByID(c.Request().Context(), planID); err != nil {
		if errors.Is(err, repository.ErrPlanNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("list price-tiers: plan lookup failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	tiers, err := h.priceTierRepo.ListByPlan(c.Request().Context(), planID)
	if err != nil {
		h.log.Error("list price-tiers failed", zap.Error(err), zap.String("planId", planID))
		return c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}

	if tiers == nil {
		tiers = []*repository.PriceTier{}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"priceTiers": tiers})
}
