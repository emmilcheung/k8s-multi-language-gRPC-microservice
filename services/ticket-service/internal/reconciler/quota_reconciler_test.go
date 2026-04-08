package reconciler_test

import (
	"context"
	"testing"

	"github.com/acme/ticket-service/internal/cache"
	"github.com/acme/ticket-service/internal/reconciler"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// ─── in-memory stubs ─────────────────────────────────────────────────────────

// stubTicketRepo is a minimal in-memory TicketRepository for unit tests.
// Only FindAll is exercised by the reconciler; all other methods panic if called
// unexpectedly so test failures surface clearly.
type stubTicketRepo struct {
	tickets []*repository.Ticket
}

func (s *stubTicketRepo) Create(_ context.Context, _ *repository.Ticket) error {
	panic("stubTicketRepo.Create not implemented")
}
func (s *stubTicketRepo) FindByID(_ context.Context, _ string) (*repository.Ticket, error) {
	panic("stubTicketRepo.FindByID not implemented")
}
func (s *stubTicketRepo) FindAll(_ context.Context, p repository.PaginationParams) ([]*repository.Ticket, error) {
	// Simple pagination: find the offset by cursor (p.After) and return up to p.Limit tickets.
	limit := p.Limit
	if limit <= 0 {
		limit = 20
	}
	start := 0
	if p.After != "" {
		for i, t := range s.tickets {
			if t.ID == p.After {
				start = i + 1
				break
			}
		}
	}
	end := start + limit
	if end > len(s.tickets) {
		end = len(s.tickets)
	}
	return s.tickets[start:end], nil
}
func (s *stubTicketRepo) Update(_ context.Context, _ *repository.Ticket) error {
	panic("stubTicketRepo.Update not implemented")
}
func (s *stubTicketRepo) ReserveTicket(_ context.Context, _, _ string) error {
	panic("stubTicketRepo.ReserveTicket not implemented")
}
func (s *stubTicketRepo) ReleaseTicket(_ context.Context, _ string) error {
	panic("stubTicketRepo.ReleaseTicket not implemented")
}
func (s *stubTicketRepo) CreateReservation(_ context.Context, _ *repository.TicketReservation) error {
	panic("stubTicketRepo.CreateReservation not implemented")
}
func (s *stubTicketRepo) FindReservationByID(_ context.Context, _ string) (*repository.TicketReservation, error) {
	panic("stubTicketRepo.FindReservationByID not implemented")
}
func (s *stubTicketRepo) ReleaseReservation(_ context.Context, _ string) error {
	panic("stubTicketRepo.ReleaseReservation not implemented")
}
func (s *stubTicketRepo) FinalizeReservation(_ context.Context, _, _ string) error {
	panic("stubTicketRepo.FinalizeReservation not implemented")
}
func (s *stubTicketRepo) Ping(_ context.Context) error  { return nil }
func (s *stubTicketRepo) Close(_ context.Context) error { return nil }
func (s *stubTicketRepo) AttachSeatingPlan(_ context.Context, _, _, _, _ string) error {
	panic("stubTicketRepo.AttachSeatingPlan not implemented")
}
func (s *stubTicketRepo) DetachSeatingPlan(_ context.Context, _, _ string) error {
	panic("stubTicketRepo.DetachSeatingPlan not implemented")
}

// stubSweeper records that SweepExpiredReservations was called and returns a
// configurable count/error.
type stubSweeper struct {
	callCount int
	returnN   int
	returnErr error
}

func (s *stubSweeper) SweepExpiredReservations(_ context.Context) (int, error) {
	s.callCount++
	return s.returnN, s.returnErr
}

// countingSeedQuotaManager wraps a real RedisQuotaManager and counts how many
// times Seed is called with force=true so tests can assert it was not called
// unnecessarily.
type countingSeedQuotaManager struct {
	cache.QuotaManager
	forceSeedCount int
}

func (c *countingSeedQuotaManager) Seed(ctx context.Context, ticketID string, available int, force bool) error {
	if force {
		c.forceSeedCount++
	}
	return c.QuotaManager.Seed(ctx, ticketID, available, force)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func newTestRedisQuotaManager(t *testing.T) (*cache.RedisQuotaManager, func()) {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	qm := cache.NewRedisQuotaManager(client)
	cleanup := func() {
		_ = client.Close()
		mr.Close()
	}
	return qm, cleanup
}

func newTestLogger(t *testing.T) *zap.Logger {
	t.Helper()
	log, err := zap.NewDevelopment()
	require.NoError(t, err)
	return log
}

// gaTicket returns a GA ticket (SeatingPlanID="") with the given quota/reserved/sold.
func gaTicket(id string, quota, reserved, sold int) *repository.Ticket {
	return &repository.Ticket{
		ID:       id,
		Quota:    quota,
		Reserved: reserved,
		Sold:     sold,
	}
}

// ─── tests ────────────────────────────────────────────────────────────────────

// TestReconciler_Run_ShouldReseedMissingKey verifies that when the Redis key
// for a GA ticket is absent the reconciler seeds it with the correct value.
func TestReconciler_Run_ShouldReseedMissingKey(t *testing.T) {
	qm, cleanup := newTestRedisQuotaManager(t)
	defer cleanup()

	// quota=5, reserved=1, sold=1 → expected available=3
	repo := &stubTicketRepo{tickets: []*repository.Ticket{gaTicket("t1", 5, 1, 1)}}
	sweeper := &stubSweeper{}
	log := newTestLogger(t)

	r := reconciler.New(repo, sweeper, qm, 0, log)
	require.NoError(t, r.Run(context.Background()))

	avail, err := qm.Available(context.Background(), "t1")
	require.NoError(t, err)
	assert.Equal(t, 3, avail)
}

// TestReconciler_Run_ShouldForceCorrectDrift verifies that when the Redis key
// exists but has a wrong value the reconciler force-corrects it.
func TestReconciler_Run_ShouldForceCorrectDrift(t *testing.T) {
	qm, cleanup := newTestRedisQuotaManager(t)
	defer cleanup()

	ctx := context.Background()

	// Pre-seed Redis with a wrong value (10 instead of 3).
	require.NoError(t, qm.Seed(ctx, "t2", 10, false))

	// quota=5, reserved=1, sold=1 → expected available=3
	repo := &stubTicketRepo{tickets: []*repository.Ticket{gaTicket("t2", 5, 1, 1)}}
	sweeper := &stubSweeper{}
	log := newTestLogger(t)

	r := reconciler.New(repo, sweeper, qm, 0, log)
	require.NoError(t, r.Run(ctx))

	avail, err := qm.Available(ctx, "t2")
	require.NoError(t, err)
	assert.Equal(t, 3, avail, "Redis should be force-corrected to 3")
}

// TestReconciler_Run_ShouldSkipSeatedTickets verifies that tickets with a
// non-empty SeatingPlanID are ignored by the reconciler (venue-service manages
// those).
func TestReconciler_Run_ShouldSkipSeatedTickets(t *testing.T) {
	qm, cleanup := newTestRedisQuotaManager(t)
	defer cleanup()

	seatedTicket := &repository.Ticket{
		ID:            "seated-1",
		SeatingPlanID: "plan-abc",
		Quota:         100,
		Reserved:      0,
		Sold:          0,
	}
	repo := &stubTicketRepo{tickets: []*repository.Ticket{seatedTicket}}
	sweeper := &stubSweeper{}
	log := newTestLogger(t)

	r := reconciler.New(repo, sweeper, qm, 0, log)
	require.NoError(t, r.Run(context.Background()))

	// The Redis key must NOT have been created for the seated ticket.
	_, err := qm.Available(context.Background(), "seated-1")
	assert.ErrorIs(t, err, cache.ErrKeyNotInitialised,
		"reconciler must not seed Redis for seated tickets")
}

// TestReconciler_Run_ShouldNotOverwriteCorrectKey verifies that when the Redis
// value already matches MongoDB truth the reconciler does not call Seed with
// force=true.
func TestReconciler_Run_ShouldNotOverwriteCorrectKey(t *testing.T) {
	baseQM, cleanup := newTestRedisQuotaManager(t)
	defer cleanup()

	ctx := context.Background()

	// Pre-seed Redis with the correct value.
	require.NoError(t, baseQM.Seed(ctx, "t3", 3, false))

	counting := &countingSeedQuotaManager{QuotaManager: baseQM}

	// quota=5, reserved=1, sold=1 → available=3 (matches Redis)
	repo := &stubTicketRepo{tickets: []*repository.Ticket{gaTicket("t3", 5, 1, 1)}}
	sweeper := &stubSweeper{}
	log := newTestLogger(t)

	r := reconciler.New(repo, sweeper, counting, 0, log)
	require.NoError(t, r.Run(ctx))

	avail, err := baseQM.Available(ctx, "t3")
	require.NoError(t, err)
	assert.Equal(t, 3, avail, "correct key must remain unchanged")
	assert.Equal(t, 0, counting.forceSeedCount, "Seed(force=true) must not be called when value is correct")
}

// TestReconciler_Run_ShouldCallSweeper verifies that the sweeper interface is
// invoked during each Run() pass.
func TestReconciler_Run_ShouldCallSweeper(t *testing.T) {
	qm, cleanup := newTestRedisQuotaManager(t)
	defer cleanup()

	repo := &stubTicketRepo{tickets: []*repository.Ticket{}}
	sweeper := &stubSweeper{returnN: 2}
	log := newTestLogger(t)

	r := reconciler.New(repo, sweeper, qm, 0, log)
	require.NoError(t, r.Run(context.Background()))

	assert.Equal(t, 1, sweeper.callCount, "sweeper must be called exactly once per Run")
}
