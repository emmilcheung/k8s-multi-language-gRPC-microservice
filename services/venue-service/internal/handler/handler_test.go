package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/repository"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// ── Stub implementations ──────────────────────────────────────────────────────

type stubVenueRepo struct {
	createFn          func(ctx context.Context, v *repository.Venue) error
	findByIDFn        func(ctx context.Context, id string) (*repository.Venue, error)
	listByOrganizerFn func(ctx context.Context, orgID string) ([]*repository.Venue, error)
	updateFn          func(ctx context.Context, v *repository.Venue) error
}

func (s *stubVenueRepo) Create(ctx context.Context, v *repository.Venue) error {
	return s.createFn(ctx, v)
}
func (s *stubVenueRepo) FindByID(ctx context.Context, id string) (*repository.Venue, error) {
	return s.findByIDFn(ctx, id)
}
func (s *stubVenueRepo) ListByOrganizer(ctx context.Context, orgID string) ([]*repository.Venue, error) {
	return s.listByOrganizerFn(ctx, orgID)
}
func (s *stubVenueRepo) Update(ctx context.Context, v *repository.Venue) error {
	return s.updateFn(ctx, v)
}
func (s *stubVenueRepo) Ping(_ context.Context) error { return nil }

type stubPlanRepo struct {
	createFn       func(ctx context.Context, p *repository.SeatingPlan) error
	findByIDFn     func(ctx context.Context, id string) (*repository.SeatingPlan, error)
	listByTicketFn func(ctx context.Context, ticketID string) ([]*repository.SeatingPlan, error)
	attachTicketFn func(ctx context.Context, planID, ticketID string, version int) error
	activateFn     func(ctx context.Context, planID string, version int) error
	updateFn       func(ctx context.Context, p *repository.SeatingPlan) error
}

func (s *stubPlanRepo) Create(ctx context.Context, p *repository.SeatingPlan) error {
	return s.createFn(ctx, p)
}
func (s *stubPlanRepo) FindByID(ctx context.Context, id string) (*repository.SeatingPlan, error) {
	return s.findByIDFn(ctx, id)
}
func (s *stubPlanRepo) ListByTicket(ctx context.Context, ticketID string) ([]*repository.SeatingPlan, error) {
	return s.listByTicketFn(ctx, ticketID)
}
func (s *stubPlanRepo) AttachTicket(ctx context.Context, planID, ticketID string, version int) error {
	return s.attachTicketFn(ctx, planID, ticketID, version)
}
func (s *stubPlanRepo) Activate(ctx context.Context, planID string, version int) error {
	return s.activateFn(ctx, planID, version)
}
func (s *stubPlanRepo) Update(ctx context.Context, p *repository.SeatingPlan) error {
	return s.updateFn(ctx, p)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func newEcho() *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	return e
}

func jsonBody(t *testing.T, v interface{}) *bytes.Buffer {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return bytes.NewBuffer(b)
}

// ── VenueHandler tests ────────────────────────────────────────────────────────

func TestVenueHandler_Create_ShouldReturn201_WhenValidRequest(t *testing.T) {
	repo := &stubVenueRepo{
		createFn: func(_ context.Context, v *repository.Venue) error {
			v.ID = "venue-id-1"
			return nil
		},
	}
	h := handler.NewVenueHandler(repo, zap.NewNop())

	e := newEcho()
	body := jsonBody(t, map[string]interface{}{
		"name":     "Grand Arena",
		"capacity": 500,
		"timezone": "America/New_York",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/venues", body)
	req.Header.Set(echo.MIMEApplicationJSON, "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	require.NoError(t, h.Create(c))
	assert.Equal(t, http.StatusCreated, rec.Code)

	var resp repository.Venue
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "venue-id-1", resp.ID)
}

func TestVenueHandler_Create_ShouldReturn401_WhenNoUserID(t *testing.T) {
	h := handler.NewVenueHandler(&stubVenueRepo{}, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/venues", jsonBody(t, map[string]interface{}{
		"name": "Arena", "capacity": 100, "timezone": "UTC",
	}))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	require.NoError(t, h.Create(c))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestVenueHandler_Create_ShouldReturn422_WhenNameMissing(t *testing.T) {
	h := handler.NewVenueHandler(&stubVenueRepo{}, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/venues", jsonBody(t, map[string]interface{}{
		"capacity": 100, "timezone": "UTC",
	}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	require.NoError(t, h.Create(c))
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestVenueHandler_Get_ShouldReturn404_WhenNotFound(t *testing.T) {
	repo := &stubVenueRepo{
		findByIDFn: func(_ context.Context, _ string) (*repository.Venue, error) {
			return nil, repository.ErrVenueNotFound
		},
	}
	h := handler.NewVenueHandler(repo, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodGet, "/api/venues/missing", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("missing")

	require.NoError(t, h.Get(c))
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

// ── PlanHandler tests ─────────────────────────────────────────────────────────

func TestPlanHandler_Activate_ShouldReturn422_WhenNotAttached(t *testing.T) {
	planStub := &stubPlanRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatingPlan, error) {
			return &repository.SeatingPlan{
				ID:          id,
				OrganizerID: "organizer-1",
				Status:      repository.PlanStatusDraft,
				Version:     1,
			}, nil
		},
		activateFn: func(_ context.Context, _ string, _ int) error {
			return repository.ErrPlanNotAttached
		},
	}

	h := handler.NewPlanHandler(planStub, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/activate",
		jsonBody(t, map[string]interface{}{"expectedVersion": 1}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("plan-1")

	require.NoError(t, h.Activate(c))
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestPlanHandler_Activate_ShouldReturn422_WhenNoSections(t *testing.T) {
	planStub := &stubPlanRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatingPlan, error) {
			return &repository.SeatingPlan{
				ID:          id,
				OrganizerID: "organizer-1",
				TicketID:    "ticket-1",
				Status:      repository.PlanStatusDraft,
				Version:     1,
			}, nil
		},
		activateFn: func(_ context.Context, _ string, _ int) error {
			return repository.ErrPlanHasNoSections
		},
	}

	h := handler.NewPlanHandler(planStub, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/activate",
		jsonBody(t, map[string]interface{}{"expectedVersion": 1}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("plan-1")

	require.NoError(t, h.Activate(c))
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestPlanHandler_Activate_ShouldReturn409_WhenAlreadyActive(t *testing.T) {
	planStub := &stubPlanRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatingPlan, error) {
			return &repository.SeatingPlan{
				ID:          id,
				OrganizerID: "organizer-1",
				TicketID:    "ticket-1",
				Status:      repository.PlanStatusDraft,
				Version:     1,
			}, nil
		},
		activateFn: func(_ context.Context, _ string, _ int) error {
			return repository.ErrPlanAlreadyActive
		},
	}

	h := handler.NewPlanHandler(planStub, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/activate",
		jsonBody(t, map[string]interface{}{"expectedVersion": 1}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("plan-1")

	require.NoError(t, h.Activate(c))
	assert.Equal(t, http.StatusConflict, rec.Code)
}

func TestPlanHandler_AttachTicket_ShouldReturn409_WhenVersionConflict(t *testing.T) {
	planStub := &stubPlanRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatingPlan, error) {
			return &repository.SeatingPlan{
				ID:          id,
				OrganizerID: "organizer-1",
				Status:      repository.PlanStatusDraft,
				Version:     2, // remote version is now 2
			}, nil
		},
		attachTicketFn: func(_ context.Context, _, _ string, _ int) error {
			return repository.ErrVersionConflict
		},
	}

	h := handler.NewPlanHandler(planStub, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/attach-ticket",
		jsonBody(t, map[string]interface{}{"ticketId": "ticket-1", "expectedVersion": 1}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("plan-1")

	require.NoError(t, h.AttachTicket(c))
	assert.Equal(t, http.StatusConflict, rec.Code)
}

func TestPlanHandler_AttachTicket_ShouldReturn403_WhenNotOwner(t *testing.T) {
	planStub := &stubPlanRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatingPlan, error) {
			return &repository.SeatingPlan{
				ID:          id,
				OrganizerID: "other-organizer",
				Status:      repository.PlanStatusDraft,
				Version:     1,
			}, nil
		},
	}

	h := handler.NewPlanHandler(planStub, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/attach-ticket",
		jsonBody(t, map[string]interface{}{"ticketId": "ticket-1", "expectedVersion": 1}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("plan-1")

	require.NoError(t, h.AttachTicket(c))
	assert.Equal(t, http.StatusForbidden, rec.Code)
}

func TestPlanHandler_Create_ShouldReturn422_WhenVenueIDMissing(t *testing.T) {
	h := handler.NewPlanHandler(&stubPlanRepo{}, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans",
		jsonBody(t, map[string]interface{}{"name": "Plan A"}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "organizer-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	require.NoError(t, h.Create(c))
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}
