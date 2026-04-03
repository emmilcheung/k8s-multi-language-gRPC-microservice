package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/hold"
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
	listByVenueFn  func(ctx context.Context, venueID, organizerID string) ([]*repository.SeatingPlan, error)
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
func (s *stubPlanRepo) ListByVenue(ctx context.Context, venueID, organizerID string) ([]*repository.SeatingPlan, error) {
	if s.listByVenueFn != nil {
		return s.listByVenueFn(ctx, venueID, organizerID)
	}
	return nil, nil
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
func (s *stubPlanRepo) ListActivePlans(_ context.Context) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (s *stubPlanRepo) Deactivate(_ context.Context, _, _ string) error { return nil }
func (s *stubPlanRepo) SaveLayout(_ context.Context, _, _ string, _ json.RawMessage) error {
	return nil
}

// stubSectionRepo satisfies repository.SectionRepository; override methods as needed.
type stubSectionRepo struct {
	listByPlanFn func(ctx context.Context, planID string) ([]*repository.Section, error)
}

func (s *stubSectionRepo) CreateSection(_ context.Context, _ *repository.Section) error { return nil }
func (s *stubSectionRepo) FindSectionByID(_ context.Context, _ string) (*repository.Section, error) {
	return nil, repository.ErrSectionNotFound
}
func (s *stubSectionRepo) ListSectionsByPlan(ctx context.Context, planID string) ([]*repository.Section, error) {
	if s.listByPlanFn != nil {
		return s.listByPlanFn(ctx, planID)
	}
	return nil, nil
}
func (s *stubSectionRepo) UpsertSeat(_ context.Context, _ *repository.Seat) error { return nil }
func (s *stubSectionRepo) BulkInsertSeats(_ context.Context, _, _, _, _ string, _, _ int) error {
	return nil
}
func (s *stubSectionRepo) ProvisionFromVenue(_ context.Context, _, _ string) (int, error) {
	return 0, nil
}
func (s *stubSectionRepo) FindSeatsBySection(_ context.Context, _ string) ([]*repository.Seat, error) {
	return nil, nil
}
func (s *stubSectionRepo) FindSeatsByIDs(_ context.Context, _ []string) ([]*repository.Seat, error) {
	return nil, nil
}
func (s *stubSectionRepo) GetAvailableSeatsInSection(_ context.Context, _ string) ([]*repository.Seat, error) {
	return nil, nil
}
func (s *stubSectionRepo) HoldSeats(_ context.Context, _ []string, _ string, _ time.Time) error {
	return nil
}
func (s *stubSectionRepo) ReleaseHold(_ context.Context, _ []string, _ string) error  { return nil }
func (s *stubSectionRepo) ReserveSeats(_ context.Context, _ []string, _ string) error { return nil }
func (s *stubSectionRepo) ReleaseReservedSeats(_ context.Context, _ []string) error   { return nil }
func (s *stubSectionRepo) SellSeats(_ context.Context, _ []string) error              { return nil }

// nopSectionRepo satisfies repository.SectionRepository with no-ops.
type nopSectionRepo struct{}

func (n *nopSectionRepo) CreateSection(_ context.Context, _ *repository.Section) error { return nil }
func (n *nopSectionRepo) FindSectionByID(_ context.Context, _ string) (*repository.Section, error) {
	return nil, repository.ErrSectionNotFound
}
func (n *nopSectionRepo) ListSectionsByPlan(_ context.Context, _ string) ([]*repository.Section, error) {
	return nil, nil
}
func (n *nopSectionRepo) UpsertSeat(_ context.Context, _ *repository.Seat) error { return nil }
func (n *nopSectionRepo) BulkInsertSeats(_ context.Context, _, _, _, _ string, _, _ int) error {
	return nil
}
func (n *nopSectionRepo) ProvisionFromVenue(_ context.Context, _, _ string) (int, error) {
	return 0, nil
}
func (n *nopSectionRepo) FindSeatsBySection(_ context.Context, _ string) ([]*repository.Seat, error) {
	return nil, nil
}
func (n *nopSectionRepo) FindSeatsByIDs(_ context.Context, _ []string) ([]*repository.Seat, error) {
	return nil, nil
}
func (n *nopSectionRepo) GetAvailableSeatsInSection(_ context.Context, _ string) ([]*repository.Seat, error) {
	return nil, nil
}
func (n *nopSectionRepo) HoldSeats(_ context.Context, _ []string, _ string, _ time.Time) error {
	return nil
}
func (n *nopSectionRepo) ReleaseHold(_ context.Context, _ []string, _ string) error  { return nil }
func (n *nopSectionRepo) ReserveSeats(_ context.Context, _ []string, _ string) error { return nil }
func (n *nopSectionRepo) ReleaseReservedSeats(_ context.Context, _ []string) error   { return nil }
func (n *nopSectionRepo) SellSeats(_ context.Context, _ []string) error              { return nil }

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

func TestPlanHandler_Get_ShouldReturn200_WithSections(t *testing.T) {
	plan := &repository.SeatingPlan{
		ID:          "plan-1",
		VenueID:     "venue-1",
		OrganizerID: "organizer-1",
		Name:        "Test Plan",
		Status:      repository.PlanStatusDraft,
		LayoutJSON:  json.RawMessage(`{"nodes":[]}`),
	}
	sectionList := []*repository.Section{{
		ID:          "section-1",
		PlanID:      "plan-1",
		Name:        "Floor A",
		Type:        repository.SectionTypeSeated,
		RowCount:    5,
		ColumnCount: 10,
	}}

	planStub := &stubPlanRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatingPlan, error) {
			return plan, nil
		},
	}
	sectionStub := &stubSectionRepo{
		listByPlanFn: func(_ context.Context, planID string) ([]*repository.Section, error) {
			return sectionList, nil
		},
	}

	h := handler.NewPlanHandler(planStub, sectionStub, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodGet, "/api/seating-plans/plan-1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("plan-1")

	require.NoError(t, h.Get(c))
	assert.Equal(t, http.StatusOK, rec.Code)

	var resp repository.SeatingPlan
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "plan-1", resp.ID)
	assert.Equal(t, "Test Plan", resp.Name)
	assert.JSONEq(t, string(plan.LayoutJSON), string(resp.LayoutJSON))
	assert.Len(t, resp.Sections, 1)
	assert.Equal(t, "Floor A", resp.Sections[0].Name)
}

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

	h := handler.NewPlanHandler(planStub, &nopSectionRepo{}, zap.NewNop())
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

	h := handler.NewPlanHandler(planStub, &nopSectionRepo{}, zap.NewNop())
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

	h := handler.NewPlanHandler(planStub, &nopSectionRepo{}, zap.NewNop())
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

	h := handler.NewPlanHandler(planStub, &nopSectionRepo{}, zap.NewNop())
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

	h := handler.NewPlanHandler(planStub, &nopSectionRepo{}, zap.NewNop())
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
	h := handler.NewPlanHandler(&stubPlanRepo{}, &nopSectionRepo{}, zap.NewNop())
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

// ── SeatHoldHandler tests ──────────────────────────────────────────────────────

type stubHoldManager struct {
	holdFn         func(ctx context.Context, planID, userID, sessionID string, seatIDs []string) (*hold.HoldResult, error)
	releaseFn      func(ctx context.Context, planID, userID string, seatIDs []string) error
	availabilityFn func(ctx context.Context, planID string) (*hold.AvailabilitySnapshot, error)
}

func (s *stubHoldManager) HoldSeats(ctx context.Context, planID, userID, sessionID string, seatIDs []string) (*hold.HoldResult, error) {
	return s.holdFn(ctx, planID, userID, sessionID, seatIDs)
}
func (s *stubHoldManager) ReleaseHold(ctx context.Context, planID, userID string, seatIDs []string) error {
	return s.releaseFn(ctx, planID, userID, seatIDs)
}
func (s *stubHoldManager) GetAvailability(ctx context.Context, planID string) (*hold.AvailabilitySnapshot, error) {
	return s.availabilityFn(ctx, planID)
}

func TestSeatHoldHandler_HoldSeats_ShouldReturn200_WhenValid(t *testing.T) {
	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	mgr := &stubHoldManager{
		holdFn: func(_ context.Context, _, _, _ string, seatIDs []string) (*hold.HoldResult, error) {
			return &hold.HoldResult{Held: seatIDs, ExpiresAt: expiresAt}, nil
		},
	}
	h := handler.NewSeatHoldHandler(mgr, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/seats/hold",
		jsonBody(t, map[string]interface{}{
			"seatIds":   []string{"seat-1", "seat-2"},
			"sessionId": "session-abc",
		}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("plan-1")

	require.NoError(t, h.HoldSeats(c))
	assert.Equal(t, http.StatusOK, rec.Code)

	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Contains(t, resp, "held")
	assert.Contains(t, resp, "expiresAt")
}

func TestSeatHoldHandler_HoldSeats_ShouldReturn401_WhenNoUserID(t *testing.T) {
	h := handler.NewSeatHoldHandler(&stubHoldManager{}, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/seats/hold",
		jsonBody(t, map[string]interface{}{"seatIds": []string{"seat-1"}}))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("plan-1")

	require.NoError(t, h.HoldSeats(c))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSeatHoldHandler_HoldSeats_ShouldReturn422_WhenNoSeatIDs(t *testing.T) {
	h := handler.NewSeatHoldHandler(&stubHoldManager{}, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/seats/hold",
		jsonBody(t, map[string]interface{}{"seatIds": []string{}}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("plan-1")

	require.NoError(t, h.HoldSeats(c))
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}

func TestSeatHoldHandler_HoldSeats_ShouldReturn409_WhenSeatNotAvailable(t *testing.T) {
	mgr := &stubHoldManager{
		holdFn: func(_ context.Context, _, _, _ string, _ []string) (*hold.HoldResult, error) {
			return nil, repository.ErrSeatNotAvailable
		},
	}
	h := handler.NewSeatHoldHandler(mgr, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/seats/hold",
		jsonBody(t, map[string]interface{}{"seatIds": []string{"seat-1"}}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("plan-1")

	require.NoError(t, h.HoldSeats(c))
	assert.Equal(t, http.StatusConflict, rec.Code)
}

func TestSeatHoldHandler_HoldSeats_ShouldReturn409_WhenPlanNotActive(t *testing.T) {
	mgr := &stubHoldManager{
		holdFn: func(_ context.Context, _, _, _ string, _ []string) (*hold.HoldResult, error) {
			return nil, hold.ErrPlanNotActive
		},
	}
	h := handler.NewSeatHoldHandler(mgr, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/seats/hold",
		jsonBody(t, map[string]interface{}{"seatIds": []string{"seat-1"}}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("plan-1")

	require.NoError(t, h.HoldSeats(c))
	assert.Equal(t, http.StatusConflict, rec.Code)
}

func TestSeatHoldHandler_ReleaseHold_ShouldReturn204_WhenValid(t *testing.T) {
	mgr := &stubHoldManager{
		releaseFn: func(_ context.Context, _, _ string, _ []string) error {
			return nil
		},
	}
	h := handler.NewSeatHoldHandler(mgr, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodPost, "/api/seating-plans/plan-1/seats/release",
		jsonBody(t, map[string]interface{}{"seatIds": []string{"seat-1"}}))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("plan-1")

	require.NoError(t, h.ReleaseHold(c))
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestSeatHoldHandler_GetAvailability_ShouldReturn200_WhenValid(t *testing.T) {
	mgr := &stubHoldManager{
		availabilityFn: func(_ context.Context, planID string) (*hold.AvailabilitySnapshot, error) {
			return &hold.AvailabilitySnapshot{
				PlanID:  planID,
				SeatMap: map[string]hold.SeatEntry{"seat-1": {Status: "available", SectionID: "sec-1"}},
				Counts:  map[string]int{"available": 1},
			}, nil
		},
	}
	h := handler.NewSeatHoldHandler(mgr, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodGet, "/api/seating-plans/plan-1/availability", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("plan-1")

	require.NoError(t, h.GetAvailability(c))
	assert.Equal(t, http.StatusOK, rec.Code)

	var resp hold.AvailabilitySnapshot
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "plan-1", resp.PlanID)
	assert.Equal(t, "available", resp.SeatMap["seat-1"].Status)
}

func TestSeatHoldHandler_GetAvailability_ShouldReturn404_WhenPlanNotFound(t *testing.T) {
	mgr := &stubHoldManager{
		availabilityFn: func(_ context.Context, _ string) (*hold.AvailabilitySnapshot, error) {
			return nil, repository.ErrPlanNotFound
		},
	}
	h := handler.NewSeatHoldHandler(mgr, zap.NewNop())
	e := newEcho()

	req := httptest.NewRequest(http.MethodGet, "/api/seating-plans/missing/availability", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("planId")
	c.SetParamValues("missing")

	require.NoError(t, h.GetAvailability(c))
	assert.Equal(t, http.StatusNotFound, rec.Code)
}
