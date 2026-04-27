package reconciler_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/reconciler"
	"github.com/acme/venue-service/internal/repository"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// ── In-memory stubs ───────────────────────────────────────────────────────────

// stubPlanRepo is a minimal in-memory PlanRepository for unit tests.
type stubPlanRepo struct {
	plans []*repository.SeatingPlan
}

func (s *stubPlanRepo) Create(_ context.Context, _ *repository.SeatingPlan) error { return nil }
func (s *stubPlanRepo) FindByID(_ context.Context, _ string) (*repository.SeatingPlan, error) {
	return nil, repository.ErrPlanNotFound
}
func (s *stubPlanRepo) FindByIDs(_ context.Context, _ []string) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (s *stubPlanRepo) ListByVenue(_ context.Context, _, _ string) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (s *stubPlanRepo) ListByTicket(_ context.Context, _, _ string) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (s *stubPlanRepo) ListActivePlans(_ context.Context) ([]*repository.SeatingPlan, error) {
	return s.plans, nil
}
func (s *stubPlanRepo) Activate(_ context.Context, _ string, _ int) error         { return nil }
func (s *stubPlanRepo) Deactivate(_ context.Context, _, _ string) error           { return nil }
func (s *stubPlanRepo) Update(_ context.Context, _ *repository.SeatingPlan) error { return nil }
func (s *stubPlanRepo) SaveLayout(_ context.Context, _, _ string, _ json.RawMessage) error {
	return nil
}

// stubSectionLister is a minimal in-memory SectionLister for unit tests.
type stubSectionLister struct {
	// sections maps planID → []*Section
	sections map[string][]*repository.Section
	// seats maps sectionID → []*Seat
	seats map[string][]*repository.Seat
}

func (s *stubSectionLister) ListSectionsByPlan(_ context.Context, planID string) ([]*repository.Section, error) {
	return s.sections[planID], nil
}

func (s *stubSectionLister) FindSeatsBySection(_ context.Context, sectionID string) ([]*repository.Seat, error) {
	return s.seats[sectionID], nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func newTestClient(t *testing.T, mr *miniredis.Miniredis) *redis.Client {
	t.Helper()
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

func newTestReconciler(
	t *testing.T,
	client *redis.Client,
	planRepo repository.PlanRepository,
	sectionRepo reconciler.SectionLister,
) *reconciler.Reconciler {
	t.Helper()
	return reconciler.NewReconciler(client, planRepo, sectionRepo, time.Minute, zap.NewNop())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestReconciler_Run_ShouldReseedMissingSeatHash verifies that when a plan's
// seats hash is absent from Redis, Run() seeds it with the correct state bytes
// from the PostgreSQL stubs.
func TestReconciler_Run_ShouldReseedMissingSeatHash(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := newTestClient(t, mr)
	defer client.Close() //nolint:errcheck

	planID := "plan-aaa"
	sectionID := "sec-1"

	planRepo := &stubPlanRepo{
		plans: []*repository.SeatingPlan{
			{ID: planID, Status: repository.PlanStatusActive},
		},
	}
	sectionRepo := &stubSectionLister{
		sections: map[string][]*repository.Section{
			planID: {{ID: sectionID, PlanID: planID, Name: "Floor"}},
		},
		seats: map[string][]*repository.Seat{
			sectionID: {
				{ID: "seat-1", SectionID: sectionID, Status: repository.SeatStatusAvailable},
				{ID: "seat-2", SectionID: sectionID, Status: repository.SeatStatusAvailable},
				{ID: "seat-3", SectionID: sectionID, Status: repository.SeatStatusHeld},
			},
		},
	}

	r := newTestReconciler(t, client, planRepo, sectionRepo)
	require.NoError(t, r.Run(context.Background()))

	hashKey := "venue:{plan-aaa}:seats"

	v1, err := client.HGet(context.Background(), hashKey, "seat-1").Result()
	require.NoError(t, err)
	assert.Equal(t, "0", v1, "AVAILABLE should map to '0'")

	v2, err := client.HGet(context.Background(), hashKey, "seat-2").Result()
	require.NoError(t, err)
	assert.Equal(t, "0", v2, "AVAILABLE should map to '0'")

	v3, err := client.HGet(context.Background(), hashKey, "seat-3").Result()
	require.NoError(t, err)
	assert.Equal(t, "1", v3, "HELD should map to '1'")
}

// TestReconciler_Run_ShouldSkipExistingHash verifies that when the seats hash
// already exists in Redis, Run() does NOT overwrite it — the hot path owns it.
func TestReconciler_Run_ShouldSkipExistingHash(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := newTestClient(t, mr)
	defer client.Close() //nolint:errcheck

	planID := "plan-bbb"
	sectionID := "sec-2"
	hashKey := "venue:{plan-bbb}:seats"

	// Pre-seed the hash with a sentinel value that should survive Run().
	ctx := context.Background()
	require.NoError(t, client.HSet(ctx, hashKey, "seat-x", "3").Err()) // SOLD

	planRepo := &stubPlanRepo{
		plans: []*repository.SeatingPlan{
			{ID: planID, Status: repository.PlanStatusActive},
		},
	}
	// The section repo would return AVAILABLE if called, but it shouldn't be.
	sectionRepo := &stubSectionLister{
		sections: map[string][]*repository.Section{
			planID: {{ID: sectionID, PlanID: planID, Name: "Balcony"}},
		},
		seats: map[string][]*repository.Seat{
			sectionID: {
				{ID: "seat-x", SectionID: sectionID, Status: repository.SeatStatusAvailable},
			},
		},
	}

	r := newTestReconciler(t, client, planRepo, sectionRepo)
	require.NoError(t, r.Run(ctx))

	// Original sentinel ("3" = SOLD) must remain — reconciler must not overwrite.
	val, err := client.HGet(ctx, hashKey, "seat-x").Result()
	require.NoError(t, err)
	assert.Equal(t, "3", val, "existing hash must not be overwritten by reconciler")
}

// TestReconciler_Run_ShouldHandleEmptyPlanList verifies that when there are no
// active plans, Run() returns no error and performs no Redis operations.
func TestReconciler_Run_ShouldHandleEmptyPlanList(t *testing.T) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()

	client := newTestClient(t, mr)
	defer client.Close() //nolint:errcheck

	planRepo := &stubPlanRepo{plans: nil}
	sectionRepo := &stubSectionLister{}

	r := newTestReconciler(t, client, planRepo, sectionRepo)
	require.NoError(t, r.Run(context.Background()))

	// Verify no keys were written.
	keys, err := client.Keys(context.Background(), "*").Result()
	require.NoError(t, err)
	assert.Empty(t, keys, "no Redis keys should be created when there are no active plans")
}
