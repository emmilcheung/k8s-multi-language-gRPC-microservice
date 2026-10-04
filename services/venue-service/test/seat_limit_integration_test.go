package test

import (
	"context"
	"testing"
	"time"

	grpcserver "github.com/acme/venue-service/internal/grpc"
	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// The per-buyer seat limit is what stops one account (or one bot) from
// sweeping a seated onsale. It has to count everything the buyer already
// has on the plan — live holds, reserved and sold seats — or the limit is
// beaten by spreading the purchase over several calls.

const (
	limitBuyer = "00000000-0000-0000-0000-0000000000a1"
	otherBuyer = "00000000-0000-0000-0000-0000000000b2"
)

func fixedLimit(n int) hold.SeatLimitFunc {
	return func(context.Context, *repository.SeatingPlan) (int, error) { return n, nil }
}

func TestSeatLimit_HoldMoreThanTheLimitInOneCall_IsRejected(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()
	mgr := hold.NewManager(nil, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), 600*time.Second, zap.NewNop())
	mgr.WithSeatLimit(fixedLimit(2))

	_, err := mgr.HoldSeats(ctx, planID, limitBuyer, "s", seatIDs)
	assert.ErrorIs(t, err, repository.ErrSeatLimitExceeded)
	assert.Equal(t, "AVAILABLE", seatStatus(t, ctx, pool, seatIDs[0]), "a refused hold must not keep any seat")
}

func TestSeatLimit_HoldingOneMoreAfterReachingTheLimit_IsRejected(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()
	mgr := hold.NewManager(nil, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), 600*time.Second, zap.NewNop())
	mgr.WithSeatLimit(fixedLimit(2))

	_, err := mgr.HoldSeats(ctx, planID, limitBuyer, "s", seatIDs[:2])
	require.NoError(t, err)

	_, err = mgr.HoldSeats(ctx, planID, limitBuyer, "s", seatIDs[2:])
	assert.ErrorIs(t, err, repository.ErrSeatLimitExceeded)

	// The limit is per buyer: someone else can still take the last seat.
	_, err = mgr.HoldSeats(ctx, planID, otherBuyer, "s", seatIDs[2:])
	assert.NoError(t, err)

	// Checking out the seats already held is the normal purchase: a held seat
	// being reserved must count once, not as a hold plus a reservation.
	srv := grpcserver.NewVenueGrpcServer(pgrepo.NewReservationRepo(pool), pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &limitTicketClient{max: 2}, zap.NewNop())
	srv.EnforceSeatLimit()
	_, err = srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId: planID, TicketId: "00000000-0000-0000-0000-000000000002", ReservationId: "dddddddd-0000-0000-0000-000000000004",
		UserId: limitBuyer, SeatIds: seatIDs[:2],
	})
	assert.NoError(t, err)
}

func TestSeatLimit_AConcurrentRequestFromTheSameBuyerIsCountedBeforeTheLimitIsChecked(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()
	mgr := hold.NewManager(nil, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), 600*time.Second, zap.NewNop())
	mgr.WithSeatLimit(fixedLimit(1))

	// Two parallel requests are each within the limit and only exceed it
	// together — what a script firing requests in parallel relies on. Play the
	// first one by hand, stopped after it has counted and written its hold but
	// before it commits. Left to chance the window is too short to hit, so the
	// race would go unnoticed.
	first, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer first.Rollback(ctx) //nolint:errcheck
	_, err = first.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, planID+":"+limitBuyer)
	require.NoError(t, err)
	_, err = first.Exec(ctx, `UPDATE seats SET status = 'HELD', held_by = $1, held_until = now() + interval '10 minutes' WHERE id = $2`,
		limitBuyer, seatIDs[0])
	require.NoError(t, err)

	second := make(chan error, 1)
	go func() {
		_, err := mgr.HoldSeats(ctx, planID, limitBuyer, "s", seatIDs[1:2])
		second <- err
	}()

	select {
	case err := <-second:
		t.Fatalf("second request finished while the first was still in flight (err=%v); it counted without seeing the first hold", err)
	case <-time.After(500 * time.Millisecond):
	}

	require.NoError(t, first.Commit(ctx))
	select {
	case err := <-second:
		assert.ErrorIs(t, err, repository.ErrSeatLimitExceeded)
	case <-time.After(10 * time.Second):
		t.Fatal("second request never finished")
	}
}

func TestSeatLimit_ReserveCountsSeatsTheBuyerAlreadyBought(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()
	repo := pgrepo.NewReservationRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(repo, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &limitTicketClient{max: 1}, zap.NewNop())
	srv.EnforceSeatLimit()

	reserve := func(resID, seat string) error {
		_, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
			PlanId: planID, TicketId: "00000000-0000-0000-0000-000000000002", ReservationId: resID,
			UserId: limitBuyer, SeatIds: []string{seat},
		})
		return err
	}

	require.NoError(t, reserve("dddddddd-0000-0000-0000-000000000001", seatIDs[0]))
	require.NoError(t, repo.FinalizeReservation(ctx, "dddddddd-0000-0000-0000-000000000001", "eeeeeeee-0000-0000-0000-000000000001"))

	// The direct seated-order path never holds first, so the reserve itself
	// has to see the sold seat.
	err := reserve("dddddddd-0000-0000-0000-000000000002", seatIDs[1])
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
	assert.Contains(t, status.Convert(err).Message(), grpcserver.SeatLimitExceededMessage)
	assert.Equal(t, "AVAILABLE", seatStatus(t, ctx, pool, seatIDs[1]))
}

func TestSeatLimit_NotEnforced_KeepsTodaysBehaviour(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	// Without WithSeatLimit / EnforceSeatLimit (the flag is off), the ticket's
	// maxPerUser is ignored: existing seated events default it to 1 and would
	// otherwise change behaviour the moment this ships.
	mgr := hold.NewManager(nil, pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), 600*time.Second, zap.NewNop())
	_, err := mgr.HoldSeats(ctx, planID, limitBuyer, "s", seatIDs)
	require.NoError(t, err)

	srv := grpcserver.NewVenueGrpcServer(pgrepo.NewReservationRepo(pool), pgrepo.NewSectionRepo(pool), pgrepo.NewPlanRepo(pool), &limitTicketClient{max: 1}, zap.NewNop())
	_, err = srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId: planID, TicketId: "00000000-0000-0000-0000-000000000002", ReservationId: "dddddddd-0000-0000-0000-000000000003",
		UserId: limitBuyer, SeatIds: seatIDs,
	})
	assert.NoError(t, err)
}

// limitTicketClient answers GetTicket with a fixed maxPerUser.
type limitTicketClient struct {
	stubTicketClient
	max int32
}

func (c *limitTicketClient) GetTicket(context.Context, *ticketsv1.GetTicketRequest, ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
	return &ticketsv1.GetTicketResponse{Price: "100.00", MaxPerUser: c.max}, nil
}
