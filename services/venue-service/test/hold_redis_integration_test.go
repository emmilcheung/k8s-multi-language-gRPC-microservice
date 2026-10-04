package test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/alicebob/miniredis/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// These tests drive the Redis hot path that production uses. The tests in
// hold_integration_test.go build the Manager without Redis, so the Lua hold
// script and its interaction with hold expiry were never exercised.

// redisHoldFixture is a Manager wired to a real PostgreSQL container and an
// in-process Redis whose clock the test controls.
type redisHoldFixture struct {
	pool        *pgxpool.Pool
	mr          *miniredis.Miniredis
	sectionRepo *pgrepo.SectionRepo
	mgr         *hold.Manager
	planID      string
	seatIDs     []string
}

func setupRedisHoldFixture(t *testing.T, ctx context.Context, holdTTL time.Duration) *redisHoldFixture {
	t.Helper()

	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	t.Cleanup(pool.Close)

	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	sectionRepo := pgrepo.NewSectionRepo(pool)
	mgr := hold.NewManager(rdb, sectionRepo, pgrepo.NewPlanRepo(pool), holdTTL, zap.NewNop())

	return &redisHoldFixture{
		pool:        pool,
		mr:          mr,
		sectionRepo: sectionRepo,
		mgr:         mgr,
		planID:      planID,
		seatIDs:     seatIDs,
	}
}

// expireHolds moves both clocks past the hold TTL: Redis drops the hold
// metadata key, and PostgreSQL's held_until falls into the past.
func (f *redisHoldFixture) expireHolds(t *testing.T, holdTTL time.Duration) {
	t.Helper()
	f.mr.FastForward(holdTTL + time.Second)
	time.Sleep(holdTTL + 100*time.Millisecond)
}

const (
	redisUserA = "00000000-0000-0000-0000-0000000000a1"
	redisUserB = "00000000-0000-0000-0000-0000000000b2"
)

// An abandoned checkout must give its seats back. Once a hold's time is up the
// next fan's hold has to succeed straight away, without waiting for a sweep —
// otherwise every abandoned cart removes seats from sale for the rest of the rush.
func TestRedisHold_ShouldLetAnotherUserHoldSeatOnceHoldExpires(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	const ttl = time.Second
	f := setupRedisHoldFixture(t, ctx, ttl)
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)

	f.expireHolds(t, ttl)

	_, err = f.mgr.HoldSeats(ctx, f.planID, redisUserB, "session-b", seat)
	assert.NoError(t, err, "an expired hold must not block the next user's hold")
}

// The hold sweeper frees expired seats in PostgreSQL. After it runs, the seat
// map shows the seat as available — so a hold on it must also succeed, or fans
// see a free seat they can never take.
func TestRedisHold_ShouldLetAnotherUserHoldSeatAfterSweeperFreesIt(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	const ttl = time.Second
	f := setupRedisHoldFixture(t, ctx, ttl)
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)

	f.expireHolds(t, ttl)
	swept, err := f.sectionRepo.SweepExpiredHolds(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 1, swept)

	snap, err := f.mgr.GetAvailability(ctx, f.planID)
	require.NoError(t, err)
	require.Equal(t, "available", snap.SeatMap[seat[0]].Status)

	_, err = f.mgr.HoldSeats(ctx, f.planID, redisUserB, "session-b", seat)
	assert.NoError(t, err, "a seat shown as available must be holdable")
}

// A live hold must still be exclusive: the fix for expiry must not let a
// second user take a seat whose hold is still running.
func TestRedisHold_ShouldRejectSecondUserWhileHoldIsLive(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	f := setupRedisHoldFixture(t, ctx, 600*time.Second)
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)

	_, err = f.mgr.HoldSeats(ctx, f.planID, redisUserB, "session-b", seat)
	assert.ErrorIs(t, err, repository.ErrSeatNotAvailable)
}

// The rush case: many fans click the same seat at the same moment. Exactly one
// may win; every other attempt must be refused, never double-held.
func TestRedisHold_ShouldGrantExactlyOneOfManyConcurrentHoldsOnOneSeat(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	f := setupRedisHoldFixture(t, ctx, 600*time.Second)
	seat := f.seatIDs[:1]

	const attempts = 500
	var wins, conflicts, others atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			user := "00000000-0000-0000-0000-" + pad12(i)
			_, err := f.mgr.HoldSeats(ctx, f.planID, user, "session", seat)
			switch {
			case err == nil:
				wins.Add(1)
			case errors.Is(err, repository.ErrSeatNotAvailable):
				conflicts.Add(1)
			default:
				others.Add(1)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	assert.EqualValues(t, 1, wins.Load(), "exactly one hold may succeed")
	assert.EqualValues(t, attempts-1, conflicts.Load(), "every other hold must be refused as unavailable")
	assert.EqualValues(t, 0, others.Load(), "no attempt may fail for any other reason")
}

func pad12(i int) string {
	s := itoa(i)
	for len(s) < 12 {
		s = "0" + s
	}
	return s
}

// reserveHeld turns the given seats into a reservation for userID through the
// Redis-synced reservation repository production wires up.
func (f *redisHoldFixture) reserveHeld(t *testing.T, ctx context.Context, repo repository.ReservationRepository, userID string, seatIDs []string) string {
	t.Helper()
	id, err := f.tryReserve(ctx, repo, userID, seatIDs)
	require.NoError(t, err)
	return id
}

func (f *redisHoldFixture) tryReserve(ctx context.Context, repo repository.ReservationRepository, userID string, seatIDs []string) (string, error) {
	expiresAt := time.Now().Add(16 * time.Minute)
	res := &repository.SeatReservation{
		ID:        uuidFor(userID),
		PlanID:    f.planID,
		TicketID:  "00000000-0000-0000-0000-000000000002",
		UserID:    userID,
		Status:    repository.ReservationStatusReserved,
		ExpiresAt: &expiresAt,
	}
	return res.ID, repo.AtomicReserveAndCreate(ctx, seatIDs, res, "50.00")
}

func uuidFor(userID string) string {
	return "11111111-1111-1111-1111-" + userID[len(userID)-12:]
}

func (f *redisHoldFixture) syncedReservations() repository.ReservationRepository {
	return hold.NewRedisSyncedReservations(pgrepo.NewReservationRepo(f.pool), f.mgr)
}

func (f *redisHoldFixture) redisSeatState(t *testing.T, seatID string) string {
	t.Helper()
	return f.mr.HGet("venue:{"+f.planID+"}:seats", seatID)
}

// When an order is cancelled its reservation is released. Those seats must go
// straight back on sale, not stay blocked until the original hold's timer runs out.
func TestRedisHold_ShouldLetAnotherUserHoldSeatOnceItsReservationIsReleased(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	f := setupRedisHoldFixture(t, ctx, 600*time.Second)
	repo := f.syncedReservations()
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)
	resID := f.reserveHeld(t, ctx, repo, redisUserA, seat)
	require.NoError(t, repo.ReleaseReservation(ctx, resID, "CANCELLED"))

	_, err = f.mgr.HoldSeats(ctx, f.planID, redisUserB, "session-b", seat)
	assert.NoError(t, err, "a released reservation must free its seats immediately")
}

// A reservation outlives the hold that led to it. When the hold's timer runs
// out, the seat is still someone's order and must stay blocked in Redis too,
// so rush traffic for it is refused without reaching PostgreSQL.
func TestRedisHold_ShouldKeepReservedSeatBlockedAfterHoldTimeRunsOut(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	const ttl = time.Second
	f := setupRedisHoldFixture(t, ctx, ttl)
	repo := f.syncedReservations()
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)
	f.reserveHeld(t, ctx, repo, redisUserA, seat)

	f.expireHolds(t, ttl)

	_, err = f.mgr.HoldSeats(ctx, f.planID, redisUserB, "session-b", seat)
	assert.ErrorIs(t, err, repository.ErrSeatNotAvailable)
	assert.Equal(t, "2", f.redisSeatState(t, seat[0]), "Redis must record the seat as reserved")
}

// A sold seat is never for sale again — not even if its buyer later calls
// release on their old hold.
func TestRedisHold_ShouldKeepSoldSeatBlockedEvenIfBuyerReleasesOldHold(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	f := setupRedisHoldFixture(t, ctx, 600*time.Second)
	repo := f.syncedReservations()
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)
	resID := f.reserveHeld(t, ctx, repo, redisUserA, seat)
	require.NoError(t, repo.FinalizeReservation(ctx, resID, "22222222-2222-2222-2222-222222222222"))

	require.NoError(t, f.mgr.ReleaseHold(ctx, f.planID, redisUserA, seat))

	_, err = f.mgr.HoldSeats(ctx, f.planID, redisUserB, "session-b", seat)
	assert.ErrorIs(t, err, repository.ErrSeatNotAvailable)
	assert.Equal(t, "3", f.redisSeatState(t, seat[0]), "Redis must record the seat as sold")
}

// A hold is a promise to one fan. Another user must not be able to place an
// order for seats someone else is still holding, and the holder must still be
// able to complete their own purchase afterwards.
func TestRedisHold_ShouldRefuseOrderForSeatsAnotherUserIsHolding(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	f := setupRedisHoldFixture(t, ctx, 600*time.Second)
	repo := f.syncedReservations()
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)

	_, err = f.tryReserve(ctx, repo, redisUserB, seat)
	assert.ErrorIs(t, err, repository.ErrSeatNotAvailable, "another user's live hold must block the order")

	_, err = f.tryReserve(ctx, repo, redisUserA, seat)
	assert.NoError(t, err, "the holder's own order must still go through")
}

// Once a hold's time is up the seat is back on sale, so an order for it must
// succeed even if no sweep has run yet.
func TestRedisHold_ShouldAcceptOrderForSeatsWhoseHoldHasExpired(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	const ttl = time.Second
	f := setupRedisHoldFixture(t, ctx, ttl)
	repo := f.syncedReservations()
	seat := f.seatIDs[:1]

	_, err := f.mgr.HoldSeats(ctx, f.planID, redisUserA, "session-a", seat)
	require.NoError(t, err)
	f.expireHolds(t, ttl)

	_, err = f.tryReserve(ctx, repo, redisUserB, seat)
	assert.NoError(t, err, "an expired hold must not block an order")
}
