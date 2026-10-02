package test

import (
	"context"
	"testing"
	"time"

	grpcserver "github.com/acme/venue-service/internal/grpc"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	expTicketID = "00000000-0000-0000-0000-000000000002"
	expUserID   = "00000000-0000-0000-0000-000000000010"
)

// reserveSeat creates a RESERVED reservation for one seat through the real
// reserve path and then forces expires_at to the given value (nil = NULL).
func reserveSeat(t *testing.T, ctx context.Context, srv *grpcserver.VenueGrpcServer, pool *pgxpool.Pool,
	planID, reservationID, seatID string, expiresAt *time.Time) {
	t.Helper()
	_, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId: planID, TicketId: expTicketID, ReservationId: reservationID,
		UserId: expUserID, SeatIds: []string{seatID},
	})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE seat_reservations SET expires_at = $1 WHERE id = $2`, expiresAt, reservationID)
	require.NoError(t, err)
}

func seatStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, seatID string) string {
	t.Helper()
	var s string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM seats WHERE id = $1`, seatID).Scan(&s))
	return s
}

func resStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var s string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM seat_reservations WHERE id = $1`, id).Scan(&s))
	return s
}

// An orphaned RESERVED reservation (no order row, nobody will release it) must
// be reclaimed once expires_at passes; everything else must be left alone.
func TestReservationExpirySweep_ShouldOnlyExpireOverdueReserved(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seats := setupHoldFixture(t, ctx)
	defer pool.Close()

	repo := pgrepo.NewReservationRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(repo, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &stubTicketClient{}, zap.NewNop())

	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(10 * time.Minute)
	const (
		rExpired = "bbbbbbbb-0000-0000-0000-000000000001"
		rFuture  = "bbbbbbbb-0000-0000-0000-000000000002"
		rNull    = "bbbbbbbb-0000-0000-0000-000000000003"
	)
	reserveSeat(t, ctx, srv, pool, planID, rExpired, seats[0], &past)
	reserveSeat(t, ctx, srv, pool, planID, rFuture, seats[1], &future)
	reserveSeat(t, ctx, srv, pool, planID, rNull, seats[2], nil)

	n, err := repo.SweepExpiredReservations(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(1), n)

	assert.Equal(t, "EXPIRED", resStatus(t, ctx, pool, rExpired))
	assert.Equal(t, "AVAILABLE", seatStatus(t, ctx, pool, seats[0]))
	assert.Equal(t, "RESERVED", resStatus(t, ctx, pool, rFuture))
	assert.Equal(t, "RESERVED", seatStatus(t, ctx, pool, seats[1]))
	assert.Equal(t, "RESERVED", resStatus(t, ctx, pool, rNull))
	assert.Equal(t, "RESERVED", seatStatus(t, ctx, pool, seats[2]))

	// Re-reserving the same id after the sweep is refused (pins existing handler behaviour).
	_, err = srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId: planID, TicketId: expTicketID, ReservationId: rExpired,
		UserId: expUserID, SeatIds: []string{seats[0]},
	})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
	assert.Contains(t, err.Error(), "was already released")
}

// SOLD and RELEASED reservations are terminal; even with a past expires_at the
// sweep must not touch them (it would otherwise free sold seats).
func TestReservationExpirySweep_ShouldNotTouchSoldOrReleased(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seats := setupHoldFixture(t, ctx)
	defer pool.Close()

	repo := pgrepo.NewReservationRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(repo, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &stubTicketClient{}, zap.NewNop())

	past := time.Now().Add(-time.Minute)
	const (
		rSold = "bbbbbbbb-0000-0000-0000-000000000004"
		rRel  = "bbbbbbbb-0000-0000-0000-000000000005"
	)
	reserveSeat(t, ctx, srv, pool, planID, rSold, seats[0], &past)
	reserveSeat(t, ctx, srv, pool, planID, rRel, seats[1], &past)
	require.NoError(t, repo.FinalizeReservation(ctx, rSold, "cccccccc-0000-0000-0000-000000000001"))
	require.NoError(t, repo.ReleaseReservation(ctx, rRel, "test"))
	// Re-reserve the released seat so a wrongly-swept RELEASED row would free it.
	const rOther = "bbbbbbbb-0000-0000-0000-000000000006"
	reserveSeat(t, ctx, srv, pool, planID, rOther, seats[1], nil)

	n, err := repo.SweepExpiredReservations(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.Equal(t, "SOLD", resStatus(t, ctx, pool, rSold))
	assert.Equal(t, "SOLD", seatStatus(t, ctx, pool, seats[0]))
	assert.Equal(t, "RELEASED", resStatus(t, ctx, pool, rRel))
	assert.Equal(t, "RESERVED", seatStatus(t, ctx, pool, seats[1]))
}

// A seat that is no longer RESERVED for this reservation (here: re-held by
// someone else) must not be flipped by the sweep.
func TestReservationExpirySweep_ShouldNotFlipSeatNoLongerReservedForReservation(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seats := setupHoldFixture(t, ctx)
	defer pool.Close()

	repo := pgrepo.NewReservationRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(repo, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &stubTicketClient{}, zap.NewNop())

	past := time.Now().Add(-time.Minute)
	const rID = "bbbbbbbb-0000-0000-0000-000000000011"
	reserveSeat(t, ctx, srv, pool, planID, rID, seats[0], &past)
	// Seat now belongs to a different reservation.
	_, err := pool.Exec(ctx, `UPDATE seats SET held_by = 'dddddddd-0000-0000-0000-000000000001' WHERE id = $1`, seats[0])
	require.NoError(t, err)

	_, err = repo.SweepExpiredReservations(ctx)
	require.NoError(t, err)

	assert.Equal(t, "EXPIRED", resStatus(t, ctx, pool, rID))
	assert.Equal(t, "RESERVED", seatStatus(t, ctx, pool, seats[0]), "seat owned by another reservation must not be freed")
}

// A second sweeper without the advisory lock must sweep nothing.
func TestReservationExpirySweep_ShouldSweepNothing_WhenAnotherPodHoldsLeaderLock(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seats := setupHoldFixture(t, ctx)
	defer pool.Close()

	repo := pgrepo.NewReservationRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(repo, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &stubTicketClient{}, zap.NewNop())
	past := time.Now().Add(-time.Minute)
	const rID = "bbbbbbbb-0000-0000-0000-000000000021"
	reserveSeat(t, ctx, srv, pool, planID, rID, seats[0], &past)

	leader, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer leader.Release()
	_, err = leader.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, "venue-reservation-sweeper")
	require.NoError(t, err)

	n, err := repo.SweepExpiredReservations(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(0), n)
	assert.Equal(t, "RESERVED", resStatus(t, ctx, pool, rID))

	_, err = leader.Exec(ctx, `SELECT pg_advisory_unlock(hashtext($1))`, "venue-reservation-sweeper")
	require.NoError(t, err)
	n, err = repo.SweepExpiredReservations(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(1), n)
}

// order-service's expiry job releases after the sweep may already have run:
// that must be an idempotent success, and must not free seats re-reserved by
// someone else in the meantime. Finalize after expiry must be refused.
func TestReservation_ReleaseAndFinalizeAfterExpiry(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seats := setupHoldFixture(t, ctx)
	defer pool.Close()

	repo := pgrepo.NewReservationRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(repo, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &stubTicketClient{}, zap.NewNop())
	past := time.Now().Add(-time.Minute)
	const rID = "bbbbbbbb-0000-0000-0000-000000000031"
	reserveSeat(t, ctx, srv, pool, planID, rID, seats[0], &past)
	_, err := repo.SweepExpiredReservations(ctx)
	require.NoError(t, err)

	// Someone else reserves the freed seat.
	const other = "bbbbbbbb-0000-0000-0000-000000000032"
	_, err = srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId: planID, TicketId: expTicketID, ReservationId: other, UserId: expUserID, SeatIds: []string{seats[0]},
	})
	require.NoError(t, err)

	resp, err := srv.ReleaseSeatReservation(ctx, &venuev1.ReleaseSeatReservationRequest{ReservationId: rID, Reason: "expired"})
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, "EXPIRED", resStatus(t, ctx, pool, rID), "release of an expired reservation is a no-op")
	assert.Equal(t, "RESERVED", seatStatus(t, ctx, pool, seats[0]), "release of an expired reservation must not free a seat now owned by another reservation")

	_, err = srv.FinalizeSeatReservation(ctx, &venuev1.FinalizeSeatReservationRequest{
		ReservationId: rID, OrderId: "cccccccc-0000-0000-0000-000000000002"})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
	assert.Equal(t, "EXPIRED", resStatus(t, ctx, pool, rID))
	assert.Equal(t, "RESERVED", seatStatus(t, ctx, pool, seats[0]), "finalize after expiry must not sell seats")
}
