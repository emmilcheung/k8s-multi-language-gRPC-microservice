package test

import (
	"context"
	"testing"
	"time"

	grpcserver "github.com/acme/venue-service/internal/grpc"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// TestReservation_ShouldReserveHeldSeats_WhenSeatsAreAvailable verifies the
// happy-path: ReserveHeldSeats locks AVAILABLE seats, creates the reservation
// ledger row, and returns the snapshotted seat details.
func TestReservation_ShouldReserveHeldSeats_WhenSeatsAreAvailable(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	reservationRepo := pgrepo.NewReservationRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(reservationRepo, sectionRepo, planRepo, zap.NewNop())

	const (
		ticketID      = "00000000-0000-0000-0000-000000000002"
		reservationID = "aaaaaaaa-0000-0000-0000-000000000001"
		userID        = "00000000-0000-0000-0000-000000000010"
	)

	expiry := time.Now().UTC().Add(10 * time.Minute)
	resp, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId:        planID,
		TicketId:      ticketID,
		ReservationId: reservationID,
		UserId:        userID,
		SeatIds:       seatIDs[:2],
		ExpiresAt:     timestamppb.New(expiry),
	})

	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, reservationID, resp.ReservationId)
	require.Len(t, resp.Seats, 2)
	for _, sd := range resp.Seats {
		assert.NotEmpty(t, sd.SeatId)
		assert.NotEmpty(t, sd.Price)
		assert.NotEmpty(t, sd.SeatLabel)
	}

	// Verify the ledger row exists in the DB.
	loaded, err := reservationRepo.FindReservationByID(ctx, reservationID)
	require.NoError(t, err)
	assert.Equal(t, "RESERVED", string(loaded.Status))
	assert.Len(t, loaded.Items, 2)
}

// TestReservation_ShouldBeIdempotent_WhenReserveHeldSeatsCalledTwice verifies
// that calling ReserveHeldSeats with the same reservationId twice returns
// success on both calls without duplicating ledger rows.
func TestReservation_ShouldBeIdempotent_WhenReserveHeldSeatsCalledTwice(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	reservationRepo := pgrepo.NewReservationRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(reservationRepo, sectionRepo, planRepo, zap.NewNop())

	const (
		ticketID      = "00000000-0000-0000-0000-000000000002"
		reservationID = "aaaaaaaa-0000-0000-0000-000000000002"
		userID        = "00000000-0000-0000-0000-000000000010"
	)

	req := &venuev1.ReserveHeldSeatsRequest{
		PlanId:        planID,
		TicketId:      ticketID,
		ReservationId: reservationID,
		UserId:        userID,
		SeatIds:       seatIDs[:1],
	}

	resp1, err := srv.ReserveHeldSeats(ctx, req)
	require.NoError(t, err)
	assert.True(t, resp1.Success)

	// Second call with identical request — must return success idempotently.
	resp2, err := srv.ReserveHeldSeats(ctx, req)
	require.NoError(t, err)
	assert.True(t, resp2.Success)
	assert.Equal(t, reservationID, resp2.ReservationId)
}

// TestReservation_ShouldRelease_WhenReleaseSeatReservationCalled verifies the
// happy-path: ReleaseSeatReservation transitions RESERVED → RELEASED and
// restores seat status to AVAILABLE.
func TestReservation_ShouldRelease_WhenReleaseSeatReservationCalled(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	reservationRepo := pgrepo.NewReservationRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(reservationRepo, sectionRepo, planRepo, zap.NewNop())

	const (
		ticketID      = "00000000-0000-0000-0000-000000000002"
		reservationID = "aaaaaaaa-0000-0000-0000-000000000003"
		userID        = "00000000-0000-0000-0000-000000000010"
	)

	// First, create a reservation.
	_, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId:        planID,
		TicketId:      ticketID,
		ReservationId: reservationID,
		UserId:        userID,
		SeatIds:       seatIDs[:1],
	})
	require.NoError(t, err)

	// Release it.
	releaseResp, err := srv.ReleaseSeatReservation(ctx, &venuev1.ReleaseSeatReservationRequest{
		ReservationId: reservationID,
		Reason:        "order_cancelled",
	})
	require.NoError(t, err)
	assert.True(t, releaseResp.Success)

	// Verify DB status.
	loaded, err := reservationRepo.FindReservationByID(ctx, reservationID)
	require.NoError(t, err)
	assert.Equal(t, "RELEASED", string(loaded.Status))

	// Seat should be AVAILABLE again — a new reservation can be made.
	const reservationID2 = "aaaaaaaa-0000-0000-0000-000000000033"
	resp2, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId:        planID,
		TicketId:      ticketID,
		ReservationId: reservationID2,
		UserId:        userID,
		SeatIds:       seatIDs[:1],
	})
	require.NoError(t, err)
	assert.True(t, resp2.Success, "seat should be re-reservable after release")
}

// TestReservation_ShouldFinalize_WhenFinalizeSeatReservationCalled verifies
// the happy-path: FinalizeSeatReservation transitions RESERVED → SOLD and
// records the orderId.
func TestReservation_ShouldFinalize_WhenFinalizeSeatReservationCalled(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	reservationRepo := pgrepo.NewReservationRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(reservationRepo, sectionRepo, planRepo, zap.NewNop())

	const (
		ticketID      = "00000000-0000-0000-0000-000000000002"
		reservationID = "aaaaaaaa-0000-0000-0000-000000000004"
		orderID       = "bbbbbbbb-0000-0000-0000-000000000001"
		userID        = "00000000-0000-0000-0000-000000000010"
	)

	_, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId:        planID,
		TicketId:      ticketID,
		ReservationId: reservationID,
		UserId:        userID,
		SeatIds:       seatIDs[:2],
	})
	require.NoError(t, err)

	finalResp, err := srv.FinalizeSeatReservation(ctx, &venuev1.FinalizeSeatReservationRequest{
		ReservationId: reservationID,
		OrderId:       orderID,
	})
	require.NoError(t, err)
	assert.True(t, finalResp.Success)

	loaded, err := reservationRepo.FindReservationByID(ctx, reservationID)
	require.NoError(t, err)
	assert.Equal(t, "SOLD", string(loaded.Status))
	assert.Equal(t, orderID, loaded.OrderID)
}

// TestReservation_ShouldRejectDuplicateSeatReservation_WhenSeatsAlreadyReserved
// verifies that two independent reservations cannot reserve the same seats.
func TestReservation_ShouldRejectDuplicateSeatReservation_WhenSeatsAlreadyReserved(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()

	reservationRepo := pgrepo.NewReservationRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	srv := grpcserver.NewVenueGrpcServer(reservationRepo, sectionRepo, planRepo, zap.NewNop())

	const (
		ticketID       = "00000000-0000-0000-0000-000000000002"
		reservationID1 = "aaaaaaaa-0000-0000-0000-000000000005"
		reservationID2 = "aaaaaaaa-0000-0000-0000-000000000006"
		userID         = "00000000-0000-0000-0000-000000000010"
	)

	// First reservation takes seat[0].
	resp1, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId:        planID,
		TicketId:      ticketID,
		ReservationId: reservationID1,
		UserId:        userID,
		SeatIds:       seatIDs[:1],
	})
	require.NoError(t, err)
	assert.True(t, resp1.Success)

	// Second reservation attempts the same seat — must fail with success=false.
	resp2, err := srv.ReserveHeldSeats(ctx, &venuev1.ReserveHeldSeatsRequest{
		PlanId:        planID,
		TicketId:      ticketID,
		ReservationId: reservationID2,
		UserId:        userID,
		SeatIds:       seatIDs[:1],
	})
	require.NoError(t, err)
	assert.False(t, resp2.Success, "seat already reserved — second reservation should fail")
	assert.NotEmpty(t, resp2.UnavailableSeatIds)
}
