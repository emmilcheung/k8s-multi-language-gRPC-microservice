package test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	gqlgraph "github.com/acme/venue-service/internal/graphql"
	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ── stub repositories ─────────────────────────────────────────────────────────

type stubVenueRepo struct {
	created  *repository.Venue
	found    *repository.Venue
	findErr  error
	list     []*repository.Venue
	listErr  error
	updateErr error
}

func (r *stubVenueRepo) Create(_ context.Context, v *repository.Venue) error {
	v.ID = "venue-1"
	r.created = v
	return nil
}
func (r *stubVenueRepo) FindByID(_ context.Context, _ string) (*repository.Venue, error) {
	return r.found, r.findErr
}
func (r *stubVenueRepo) ListByOrganizer(_ context.Context, _ string) ([]*repository.Venue, error) {
	return r.list, r.listErr
}
func (r *stubVenueRepo) Update(_ context.Context, v *repository.Venue) error {
	return r.updateErr
}
func (r *stubVenueRepo) Ping(_ context.Context) error { return nil }

type stubVenueSectionRepo struct {
	created *repository.VenueSection
	found   *repository.VenueSection
	findErr error
}

func (r *stubVenueSectionRepo) Create(_ context.Context, vs *repository.VenueSection) error {
	vs.ID = "section-1"
	r.created = vs
	return nil
}
func (r *stubVenueSectionRepo) FindByID(_ context.Context, _ string) (*repository.VenueSection, error) {
	return r.found, r.findErr
}
func (r *stubVenueSectionRepo) ListByVenue(_ context.Context, _ string) ([]*repository.VenueSection, error) {
	return nil, nil
}
func (r *stubVenueSectionRepo) Update(_ context.Context, _ *repository.VenueSection) error {
	return nil
}
func (r *stubVenueSectionRepo) Delete(_ context.Context, _, _ string) error { return nil }

type stubPriceTierRepo struct {
	created *repository.PriceTier
}

func (r *stubPriceTierRepo) Create(_ context.Context, t *repository.PriceTier) error {
	t.ID = "tier-1"
	r.created = t
	return nil
}
func (r *stubPriceTierRepo) ListByPlan(_ context.Context, _ string) ([]*repository.PriceTier, error) {
	return nil, nil
}

type stubHoldMgr struct{}

func (h *stubHoldMgr) HoldSeats(_ context.Context, _, _, _ string, seatIDs []string) (*hold.HoldResult, error) {
	return &hold.HoldResult{Held: seatIDs, ExpiresAt: time.Now().Add(5 * time.Minute)}, nil
}
func (h *stubHoldMgr) ReleaseHold(_ context.Context, _, _ string, _ []string) error { return nil }

// stubPlanRepo is a minimal PlanRepository for DataLoader tests.
type stubPlanRepo struct {
	plans        map[string]*repository.SeatingPlan
	findByIDsN   int // counts FindByIDs calls for N+1 verification
}

func (r *stubPlanRepo) Create(_ context.Context, p *repository.SeatingPlan) error {
	p.ID = "plan-1"
	return nil
}
func (r *stubPlanRepo) FindByID(_ context.Context, id string) (*repository.SeatingPlan, error) {
	if p, ok := r.plans[id]; ok {
		return p, nil
	}
	return nil, repository.ErrPlanNotFound
}
func (r *stubPlanRepo) FindByIDs(_ context.Context, ids []string) ([]*repository.SeatingPlan, error) {
	r.findByIDsN++
	result := make([]*repository.SeatingPlan, len(ids))
	for i, id := range ids {
		result[i] = r.plans[id]
	}
	return result, nil
}
func (r *stubPlanRepo) ListByVenue(_ context.Context, _, _ string) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (r *stubPlanRepo) ListByTicket(_ context.Context, _, _ string) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (r *stubPlanRepo) ListActivePlans(_ context.Context) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (r *stubPlanRepo) Activate(_ context.Context, _ string, _ int) error         { return nil }
func (r *stubPlanRepo) Deactivate(_ context.Context, _, _ string) error           { return nil }
func (r *stubPlanRepo) Update(_ context.Context, _ *repository.SeatingPlan) error { return nil }
func (r *stubPlanRepo) SaveLayout(_ context.Context, _, _ string, _ json.RawMessage) error {
	return nil
}

type stubSectionRepo struct{}

func (r *stubSectionRepo) CreateSection(_ context.Context, s *repository.Section) error {
	s.ID = "section-plan-1"
	return nil
}
func (r *stubSectionRepo) FindSectionByID(_ context.Context, _ string) (*repository.Section, error) {
	return nil, errors.New("not found")
}
func (r *stubSectionRepo) ListSectionsByPlan(_ context.Context, _ string) ([]*repository.Section, error) {
	return []*repository.Section{}, nil
}
func (r *stubSectionRepo) UpsertSeat(_ context.Context, _ *repository.Seat) error { return nil }
func (r *stubSectionRepo) ProvisionFromVenue(_ context.Context, _, _ string) (int, error) {
	return 0, nil
}
func (r *stubSectionRepo) BulkInsertSeats(_ context.Context, _, _, _, _ string, _, _ int) error {
	return nil
}
func (r *stubSectionRepo) FindSeatsBySection(_ context.Context, _ string) ([]*repository.Seat, error) {
	return []*repository.Seat{}, nil
}
func (r *stubSectionRepo) FindSeatsByIDs(_ context.Context, _ []string) ([]*repository.Seat, error) {
	return []*repository.Seat{}, nil
}
func (r *stubSectionRepo) GetAvailableSeatsInSection(_ context.Context, _ string) ([]*repository.Seat, error) {
	return []*repository.Seat{}, nil
}
func (r *stubSectionRepo) HoldSeats(_ context.Context, _ []string, _ string, _ time.Time) error {
	return nil
}
func (r *stubSectionRepo) ReleaseHold(_ context.Context, _ []string, _ string) error { return nil }
func (r *stubSectionRepo) ReserveSeats(_ context.Context, _ []string, _ string) error { return nil }
func (r *stubSectionRepo) ReleaseReservedSeats(_ context.Context, _ []string) error   { return nil }
func (r *stubSectionRepo) SellSeats(_ context.Context, _ []string) error              { return nil }

// ── helpers ───────────────────────────────────────────────────────────────────

func contextWithUserID(userID string) context.Context {
	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	req.Header.Set("X-User-Id", userID)
	return gqlgraph.WithHTTPRequest(context.Background(), req)
}

func newResolver() *gqlgraph.Resolver {
	return &gqlgraph.Resolver{
		PlanRepo:         &stubPlanRepo{plans: map[string]*repository.SeatingPlan{}},
		SectionRepo:      &stubSectionRepo{},
		VenueRepo:        &stubVenueRepo{},
		VenueSectionRepo: &stubVenueSectionRepo{},
		PriceTierRepo:    &stubPriceTierRepo{},
		HoldMgr:          &stubHoldMgr{},
	}
}

// ── CreateVenue tests ─────────────────────────────────────────────────────────

func TestGraphQL_CreateVenue_HappyPath(t *testing.T) {
	venueRepo := &stubVenueRepo{}
	r := &gqlgraph.Resolver{
		PlanRepo:         &stubPlanRepo{plans: map[string]*repository.SeatingPlan{}},
		SectionRepo:      &stubSectionRepo{},
		VenueRepo:        venueRepo,
		VenueSectionRepo: &stubVenueSectionRepo{},
		PriceTierRepo:    &stubPriceTierRepo{},
		HoldMgr:          &stubHoldMgr{},
	}

	ctx := contextWithUserID("org-1")
	addr := "123 Main St"
	result, err := r.Mutation().CreateVenue(ctx, gqlgraph.CreateVenueInput{
		Name:     "Grand Hall",
		Capacity: 500,
		Timezone: "America/New_York",
		Address:  &addr,
	})

	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "venue-1", result.ID)
	assert.Equal(t, "Grand Hall", result.Name)
	assert.Equal(t, "org-1", result.OrganizerID)
	assert.Equal(t, 500, result.Capacity)
	assert.Equal(t, "America/New_York", result.Timezone)
	assert.Equal(t, "123 Main St", result.Address)
	require.NotNil(t, venueRepo.created)
	assert.Equal(t, "org-1", venueRepo.created.OrganizerID)
}

func TestGraphQL_CreateVenue_Unauthorized_WhenNoUserID(t *testing.T) {
	r := newResolver()
	// Empty context — no X-User-Id header.
	_, err := r.Mutation().CreateVenue(context.Background(), gqlgraph.CreateVenueInput{
		Name:     "Test Venue",
		Capacity: 100,
		Timezone: "UTC",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

// ── Venues query tests ────────────────────────────────────────────────────────

func TestGraphQL_Venues_ReturnsOrganizersVenues(t *testing.T) {
	venueRepo := &stubVenueRepo{
		list: []*repository.Venue{
			{ID: "v1", OrganizerID: "org-1", Name: "Venue A", Capacity: 200, Timezone: "UTC"},
			{ID: "v2", OrganizerID: "org-1", Name: "Venue B", Capacity: 300, Timezone: "UTC"},
		},
	}
	r := &gqlgraph.Resolver{
		PlanRepo:         &stubPlanRepo{plans: map[string]*repository.SeatingPlan{}},
		SectionRepo:      &stubSectionRepo{},
		VenueRepo:        venueRepo,
		VenueSectionRepo: &stubVenueSectionRepo{},
		PriceTierRepo:    &stubPriceTierRepo{},
		HoldMgr:          &stubHoldMgr{},
	}

	ctx := contextWithUserID("org-1")
	result, err := r.Query().Venues(ctx)

	require.NoError(t, err)
	require.Len(t, result, 2)
	assert.Equal(t, "v1", result[0].ID)
	assert.Equal(t, "Venue A", result[0].Name)
}

func TestGraphQL_Venues_Unauthorized_WhenNoUserID(t *testing.T) {
	r := newResolver()
	_, err := r.Query().Venues(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

// ── HoldSeats tests ───────────────────────────────────────────────────────────

func TestGraphQL_HoldSeats_HappyPath(t *testing.T) {
	r := newResolver()
	ctx := contextWithUserID("user-1")

	seatIDs := []string{"seat-1", "seat-2", "seat-3"}
	result, err := r.Mutation().HoldSeats(ctx, "plan-1", seatIDs)

	require.NoError(t, err)
	require.NotNil(t, result)
	assert.ElementsMatch(t, seatIDs, result.Held)
	assert.NotEmpty(t, result.ExpiresAt)
}

func TestGraphQL_HoldSeats_Unauthorized_WhenNoUserID(t *testing.T) {
	r := newResolver()
	_, err := r.Mutation().HoldSeats(context.Background(), "plan-1", []string{"seat-1"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

// ── DataLoader N+1 test ───────────────────────────────────────────────────────

// TestGraphQL_DataLoader_BatchesPlanFetches verifies that loading multiple
// SeatingPlan entities in one request batches the FindByIDs call rather than
// issuing N individual queries.
func TestGraphQL_DataLoader_BatchesPlanFetches(t *testing.T) {
	planA := &repository.SeatingPlan{
		ID: "plan-a", AssignmentMode: "manual", Status: repository.PlanStatusDraft,
	}
	planB := &repository.SeatingPlan{
		ID: "plan-b", AssignmentMode: "auto", Status: repository.PlanStatusActive,
	}
	planRepo := &stubPlanRepo{
		plans: map[string]*repository.SeatingPlan{
			"plan-a": planA,
			"plan-b": planB,
		},
	}
	sectionRepo := &stubSectionRepo{}
	loader := gqlgraph.NewPlanLoader(planRepo, sectionRepo)

	ctx := gqlgraph.WithPlanLoader(context.Background(), loader)

	// Queue two loads without awaiting them.
	thunkA := loader.Load(ctx, "plan-a")
	thunkB := loader.Load(ctx, "plan-b")

	// Await both — this triggers a single batched FindByIDs call.
	resultA, err := thunkA()
	require.NoError(t, err)
	require.NotNil(t, resultA)
	assert.Equal(t, "plan-a", resultA.ID)

	resultB, err := thunkB()
	require.NoError(t, err)
	require.NotNil(t, resultB)
	assert.Equal(t, "plan-b", resultB.ID)

	assert.Equal(t, 1, planRepo.findByIDsN, "expected exactly 1 batched FindByIDs call, got %d", planRepo.findByIDsN)
}
