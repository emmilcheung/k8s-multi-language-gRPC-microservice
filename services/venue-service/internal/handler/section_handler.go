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

// SectionHandler handles section and price-tier endpoints inside a seating plan.
type SectionHandler struct {
	planRepo      repository.PlanRepository
	sectionRepo   repository.SectionRepository
	priceTierRepo PriceTierRepository
	validator     *security.UserIDSignatureValidator
	access        *Access
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
		access:        legacyAccess(log),
		log:           log,
	}
}

// WithAccess sends organizer writes through the permission check.
func (h *SectionHandler) WithAccess(a *Access) *SectionHandler {
	h.access = a
	return h
}

// authorizePlan loads the plan and checks the caller may change it. When
// handled is true the response has been written.
func (h *SectionHandler) authorizePlan(c echo.Context, organizerID, planID string) (plan *repository.SeatingPlan, actorUser, actorAccount string, handled bool, err error) {
	ctx := c.Request().Context()
	plan, ferr := h.planRepo.FindByID(ctx, planID)
	if ferr != nil {
		if errors.Is(ferr, repository.ErrPlanNotFound) {
			return nil, "", "", true, c.JSON(http.StatusNotFound, errorResponse("seating plan not found"))
		}
		h.log.Error("plan lookup failed", zap.Error(ferr), zap.String("planId", planID))
		return nil, "", "", true, c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
	}
	caller, acting, cerr := h.access.Caller(c, organizerID)
	if done, e := h.access.Fail(c, h.log, cerr, 0, ""); done {
		return nil, "", "", true, e
	}
	account, aerr := h.access.org.AuthorizePlanEdit(ctx, caller, acting, plan)
	if done, e := h.access.Fail(c, h.log, aerr, http.StatusForbidden, "not the plan owner"); done {
		return nil, "", "", true, e
	}
	return plan, caller.UserID, account, false, nil
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

	plan, actorUser, actorAccount, handled, err := h.authorizePlan(c, organizerID, planID)
	if handled {
		return err
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

	ctx := c.Request().Context()
	err = h.access.org.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, actorUser, actorAccount, service.ActionSectionCreate, "seating_plan:"+planID, nil,
			map[string]any{"sectionId": s.ID, "name": s.Name, "type": req.Type, "rowCount": s.RowCount, "columnCount": s.ColumnCount})
	}, func(ctx context.Context) error {
		if err := h.sectionRepo.CreateSection(ctx, s); err != nil {
			return err
		}
		// Auto-generate seat rows for the new section.
		return h.sectionRepo.BulkInsertSeats(ctx, s.ID, planID, req.Type, req.PriceTierID, req.RowCount, req.ColumnCount)
	})
	if err != nil {
		h.log.Error("section create failed", zap.Error(err), zap.String("planId", planID))
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

	plan, actorUser, actorAccount, handled, err := h.authorizePlan(c, organizerID, planID)
	if handled {
		return err
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

	ctx := c.Request().Context()
	err = h.access.org.Audited(ctx, func() audit.Entry {
		return service.ChangeEntry(ctx, actorUser, actorAccount, service.ActionPriceTierCreate, "seating_plan:"+planID, nil,
			map[string]any{"priceTierId": t.ID, "name": t.Name, "price": t.Price})
	}, func(ctx context.Context) error { return h.priceTierRepo.Create(ctx, t) })
	if err != nil {
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
