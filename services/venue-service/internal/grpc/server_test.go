package grpcserver_test

import (
	"context"
	"testing"
	"time"

	grpcserver "github.com/acme/venue-service/internal/grpc"
	"github.com/acme/venue-service/internal/repository"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ── stub repositories ─────────────────────────────────────────────────────────

// stubReservationRepo is a configurable in-memory stub for ReservationRepository.
type stubReservationRepo struct {
	findByIDFn          func(ctx context.Context, id string) (*repository.SeatReservation, error)
	atomicReserveAndFn  func(ctx context.Context, seatIDs []string, r *repository.SeatReservation) error
	releaseReservFn     func(ctx context.Context, reservationID, reason string) error
	finalizeReservFn    func(ctx context.Context, reservationID, orderID string) error
	createReservationFn func(ctx context.Context, r *repository.SeatReservation) error
}

func (s *stubReservationRepo) FindReservationByID(ctx context.Context, id string) (*repository.SeatReservation, error) {
	if s.findByIDFn != nil {
		return s.findByIDFn(ctx, id)
	}
	return nil, repository.ErrReservationNotFound
}

func (s *stubReservationRepo) AtomicReserveAndCreate(ctx context.Context, seatIDs []string, r *repository.SeatReservation) error {
	if s.atomicReserveAndFn != nil {
		return s.atomicReserveAndFn(ctx, seatIDs, r)
	}
	return nil
}

func (s *stubReservationRepo) ReleaseReservation(ctx context.Context, reservationID, reason string) error {
	if s.releaseReservFn != nil {
		return s.releaseReservFn(ctx, reservationID, reason)
	}
	return nil
}

func (s *stubReservationRepo) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	if s.finalizeReservFn != nil {
		return s.finalizeReservFn(ctx, reservationID, orderID)
	}
	return nil
}

func (s *stubReservationRepo) CreateReservation(ctx context.Context, r *repository.SeatReservation) error {
	if s.createReservationFn != nil {
		return s.createReservationFn(ctx, r)
	}
	return nil
}

// nopSectionRepo satisfies SectionRepository with no-ops (not used by CP-10 RPCs).
type nopSectionRepo struct{}

func (n *nopSectionRepo) CreateSection(ctx context.Context, s *repository.Section) error {
	return nil
}
func (n *nopSectionRepo) FindSectionByID(ctx context.Context, id string) (*repository.Section, error) {
	return nil, repository.ErrSectionNotFound
}
func (n *nopSectionRepo) ListSectionsByPlan(ctx context.Context, planID string) ([]*repository.Section, error) {
	return nil, nil
}
func (n *nopSectionRepo) UpsertSeat(ctx context.Context, seat *repository.Seat) error { return nil }
func (n *nopSectionRepo) FindSeatsBySection(ctx context.Context, sectionID string) ([]*repository.Seat, error) {
	return nil, nil
}
func (n *nopSectionRepo) FindSeatsByIDs(ctx context.Context, seatIDs []string) ([]*repository.Seat, error) {
	return nil, nil
}
func (n *nopSectionRepo) GetAvailableSeatsInSection(ctx context.Context, sectionID string) ([]*repository.Seat, error) {
	return nil, nil
}
func (n *nopSectionRepo) HoldSeats(ctx context.Context, seatIDs []string, userID string, expiresAt time.Time) error {
	return nil
}
func (n *nopSectionRepo) ReleaseHold(ctx context.Context, seatIDs []string, userID string) error {
	return nil
}
func (n *nopSectionRepo) ReserveSeats(ctx context.Context, seatIDs []string, reservationID string) error {
	return nil
}
func (n *nopSectionRepo) ReleaseReservedSeats(ctx context.Context, seatIDs []string) error {
	return nil
}
func (n *nopSectionRepo) SellSeats(ctx context.Context, seatIDs []string) error { return nil }

// nopPlanRepo satisfies PlanRepository with no-ops.
type nopPlanRepo struct{}

func (n *nopPlanRepo) Create(ctx context.Context, p *repository.SeatingPlan) error { return nil }
func (n *nopPlanRepo) FindByID(ctx context.Context, id string) (*repository.SeatingPlan, error) {
	return nil, repository.ErrPlanNotFound
}
func (n *nopPlanRepo) ListByTicket(ctx context.Context, ticketID string) ([]*repository.SeatingPlan, error) {
	return nil, nil
}
func (n *nopPlanRepo) AttachTicket(ctx context.Context, planID, ticketID string, expectedVersion int) error {
	return nil
}
func (n *nopPlanRepo) Activate(ctx context.Context, planID string, expectedVersion int) error {
	return nil
}
func (n *nopPlanRepo) Update(ctx context.Context, p *repository.SeatingPlan) error { return nil }

// newTestServer creates a VenueGrpcServer with the given reservation repo stub.
func newTestServer(rr repository.ReservationRepository) *grpcserver.VenueGrpcServer {
	return grpcserver.NewVenueGrpcServer(rr, &nopSectionRepo{}, &nopPlanRepo{}, zap.NewNop())
}

// ── ReserveHeldSeats tests ────────────────────────────────────────────────────

func TestReserveHeldSeats_ShouldReturnInvalidArgument_WhenPlanIdMissing(t *testing.T) {
	srv := newTestServer(&stubReservationRepo{})
	_, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		TicketId:      "ticket-1",
		ReservationId: "res-1",
		UserId:        "user-1",
		SeatIds:       []string{"seat-1"},
	})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestReserveHeldSeats_ShouldReturnInvalidArgument_WhenSeatIdsEmpty(t *testing.T) {
	srv := newTestServer(&stubReservationRepo{})
	_, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-1",
		UserId:        "user-1",
		SeatIds:       nil,
	})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestReserveHeldSeats_ShouldReturnSuccessImmediately_WhenReservationAlreadyReserved(t *testing.T) {
	items := []repository.SeatReservationItem{
		{ReservationID: "res-1", SeatID: "seat-1", SectionID: "sec-1", Price: "50.00", SeatLabel: "A1"},
	}
	stub := &stubReservationRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatReservation, error) {
			return &repository.SeatReservation{
				ID:     id,
				Status: repository.ReservationStatusReserved,
				Items:  items,
			}, nil
		},
	}

	srv := newTestServer(stub)
	resp, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-1",
		UserId:        "user-1",
		SeatIds:       []string{"seat-1"},
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, "res-1", resp.ReservationId)
	require.Len(t, resp.Seats, 1)
	assert.Equal(t, "seat-1", resp.Seats[0].SeatId)
	assert.Equal(t, "50.00", resp.Seats[0].Price)
}

func TestReserveHeldSeats_ShouldReturnFailedPrecondition_WhenReservationAlreadyReleased(t *testing.T) {
	stub := &stubReservationRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatReservation, error) {
			return &repository.SeatReservation{ID: id, Status: repository.ReservationStatusReleased}, nil
		},
	}

	srv := newTestServer(stub)
	_, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-1",
		UserId:        "user-1",
		SeatIds:       []string{"seat-1"},
	})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
}

func TestReserveHeldSeats_ShouldReturnFailedPrecondition_WhenReservationAlreadySold(t *testing.T) {
	stub := &stubReservationRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatReservation, error) {
			return &repository.SeatReservation{ID: id, Status: repository.ReservationStatusSold}, nil
		},
	}

	srv := newTestServer(stub)
	_, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-1",
		UserId:        "user-1",
		SeatIds:       []string{"seat-1"},
	})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
}

func TestReserveHeldSeats_ShouldSucceed_WhenSeatsAreReservable(t *testing.T) {
	stub := &stubReservationRepo{
		// No existing reservation.
		findByIDFn: func(_ context.Context, _ string) (*repository.SeatReservation, error) {
			return nil, repository.ErrReservationNotFound
		},
		atomicReserveAndFn: func(_ context.Context, seatIDs []string, r *repository.SeatReservation) error {
			r.Items = []repository.SeatReservationItem{
				{ReservationID: r.ID, SeatID: seatIDs[0], SectionID: "sec-1", Price: "75.00", SeatLabel: "B2"},
			}
			return nil
		},
	}

	expiry := time.Now().Add(10 * time.Minute)
	srv := newTestServer(stub)
	resp, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-99",
		UserId:        "user-1",
		SeatIds:       []string{"seat-A"},
		ExpiresAt:     timestamppb.New(expiry),
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, "res-99", resp.ReservationId)
	require.Len(t, resp.Seats, 1)
	assert.Equal(t, "seat-A", resp.Seats[0].SeatId)
	assert.Equal(t, "75.00", resp.Seats[0].Price)
}

func TestReserveHeldSeats_ShouldReturnUnavailableSeats_WhenSeatsNotReservable(t *testing.T) {
	stub := &stubReservationRepo{
		findByIDFn: func(_ context.Context, _ string) (*repository.SeatReservation, error) {
			return nil, repository.ErrReservationNotFound
		},
		atomicReserveAndFn: func(_ context.Context, _ []string, _ *repository.SeatReservation) error {
			return repository.ErrSeatNotAvailable
		},
	}

	srv := newTestServer(stub)
	resp, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-1",
		UserId:        "user-1",
		SeatIds:       []string{"seat-X", "seat-Y"},
	})
	require.NoError(t, err)
	assert.False(t, resp.Success)
	assert.ElementsMatch(t, []string{"seat-X", "seat-Y"}, resp.UnavailableSeatIds)
}

func TestReserveHeldSeats_ShouldReturnInternal_WhenAtomicReserveFails(t *testing.T) {
	stub := &stubReservationRepo{
		findByIDFn: func(_ context.Context, _ string) (*repository.SeatReservation, error) {
			return nil, repository.ErrReservationNotFound
		},
		atomicReserveAndFn: func(_ context.Context, _ []string, _ *repository.SeatReservation) error {
			return assert.AnError
		},
	}

	srv := newTestServer(stub)
	_, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-1",
		UserId:        "user-1",
		SeatIds:       []string{"seat-1"},
	})
	require.Error(t, err)
	assert.Equal(t, codes.Internal, status.Code(err))
}

func TestReserveHeldSeats_ShouldReturnSuccess_WhenConcurrentDuplicateDetected(t *testing.T) {
	// When AtomicReserveAndCreate returns ErrReservationAlreadyDone the handler
	// reloads and returns success idempotently.
	items := []repository.SeatReservationItem{
		{ReservationID: "res-dup", SeatID: "seat-1", SectionID: "sec-1", Price: "50.00", SeatLabel: "A1"},
	}
	callCount := 0
	stub := &stubReservationRepo{
		findByIDFn: func(_ context.Context, id string) (*repository.SeatReservation, error) {
			callCount++
			if callCount == 1 {
				// First call: not found → proceeds to atomic.
				return nil, repository.ErrReservationNotFound
			}
			// Second call (reload after duplicate): found.
			return &repository.SeatReservation{ID: id, Status: repository.ReservationStatusReserved, Items: items}, nil
		},
		atomicReserveAndFn: func(_ context.Context, _ []string, _ *repository.SeatReservation) error {
			return repository.ErrReservationAlreadyDone
		},
	}

	srv := newTestServer(stub)
	resp, err := srv.ReserveHeldSeats(context.Background(), &venuev1.ReserveHeldSeatsRequest{
		PlanId:        "plan-1",
		TicketId:      "ticket-1",
		ReservationId: "res-dup",
		UserId:        "user-1",
		SeatIds:       []string{"seat-1"},
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, "res-dup", resp.ReservationId)
}

// ── ReleaseSeatReservation tests ──────────────────────────────────────────────

func TestReleaseSeatReservation_ShouldReturnInvalidArgument_WhenReservationIdMissing(t *testing.T) {
	srv := newTestServer(&stubReservationRepo{})
	_, err := srv.ReleaseSeatReservation(context.Background(), &venuev1.ReleaseSeatReservationRequest{
		ReservationId: "",
	})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestReleaseSeatReservation_ShouldSucceed_WhenReservationReleased(t *testing.T) {
	stub := &stubReservationRepo{
		releaseReservFn: func(_ context.Context, _, _ string) error { return nil },
	}

	srv := newTestServer(stub)
	resp, err := srv.ReleaseSeatReservation(context.Background(), &venuev1.ReleaseSeatReservationRequest{
		ReservationId: "res-1",
		Reason:        "order_cancelled",
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

func TestReleaseSeatReservation_ShouldSucceedIdempotently_WhenAlreadyReleased(t *testing.T) {
	stub := &stubReservationRepo{
		releaseReservFn: func(_ context.Context, _, _ string) error {
			return repository.ErrReservationAlreadyDone
		},
	}

	srv := newTestServer(stub)
	resp, err := srv.ReleaseSeatReservation(context.Background(), &venuev1.ReleaseSeatReservationRequest{
		ReservationId: "res-1",
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

func TestReleaseSeatReservation_ShouldReturnNotFound_WhenReservationMissing(t *testing.T) {
	stub := &stubReservationRepo{
		releaseReservFn: func(_ context.Context, _, _ string) error {
			return repository.ErrReservationNotFound
		},
	}

	srv := newTestServer(stub)
	_, err := srv.ReleaseSeatReservation(context.Background(), &venuev1.ReleaseSeatReservationRequest{
		ReservationId: "res-missing",
	})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestReleaseSeatReservation_ShouldReturnFailedPrecondition_WhenAlreadySold(t *testing.T) {
	stub := &stubReservationRepo{
		releaseReservFn: func(_ context.Context, _, _ string) error {
			return repository.ErrReservationConflict
		},
	}

	srv := newTestServer(stub)
	_, err := srv.ReleaseSeatReservation(context.Background(), &venuev1.ReleaseSeatReservationRequest{
		ReservationId: "res-sold",
	})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
}

// ── FinalizeSeatReservation tests ─────────────────────────────────────────────

func TestFinalizeSeatReservation_ShouldReturnInvalidArgument_WhenReservationIdMissing(t *testing.T) {
	srv := newTestServer(&stubReservationRepo{})
	_, err := srv.FinalizeSeatReservation(context.Background(), &venuev1.FinalizeSeatReservationRequest{
		OrderId: "order-1",
	})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestFinalizeSeatReservation_ShouldReturnInvalidArgument_WhenOrderIdMissing(t *testing.T) {
	srv := newTestServer(&stubReservationRepo{})
	_, err := srv.FinalizeSeatReservation(context.Background(), &venuev1.FinalizeSeatReservationRequest{
		ReservationId: "res-1",
	})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestFinalizeSeatReservation_ShouldSucceed_WhenReservationFinalized(t *testing.T) {
	stub := &stubReservationRepo{
		finalizeReservFn: func(_ context.Context, _, _ string) error { return nil },
	}

	srv := newTestServer(stub)
	resp, err := srv.FinalizeSeatReservation(context.Background(), &venuev1.FinalizeSeatReservationRequest{
		ReservationId: "res-1",
		OrderId:       "order-1",
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

func TestFinalizeSeatReservation_ShouldSucceedIdempotently_WhenAlreadySold(t *testing.T) {
	stub := &stubReservationRepo{
		finalizeReservFn: func(_ context.Context, _, _ string) error {
			return repository.ErrReservationAlreadyDone
		},
	}

	srv := newTestServer(stub)
	resp, err := srv.FinalizeSeatReservation(context.Background(), &venuev1.FinalizeSeatReservationRequest{
		ReservationId: "res-1",
		OrderId:       "order-1",
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

func TestFinalizeSeatReservation_ShouldReturnNotFound_WhenReservationMissing(t *testing.T) {
	stub := &stubReservationRepo{
		finalizeReservFn: func(_ context.Context, _, _ string) error {
			return repository.ErrReservationNotFound
		},
	}

	srv := newTestServer(stub)
	_, err := srv.FinalizeSeatReservation(context.Background(), &venuev1.FinalizeSeatReservationRequest{
		ReservationId: "res-missing",
		OrderId:       "order-1",
	})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestFinalizeSeatReservation_ShouldReturnFailedPrecondition_WhenAlreadyReleased(t *testing.T) {
	stub := &stubReservationRepo{
		finalizeReservFn: func(_ context.Context, _, _ string) error {
			return repository.ErrReservationConflict
		},
	}

	srv := newTestServer(stub)
	_, err := srv.FinalizeSeatReservation(context.Background(), &venuev1.FinalizeSeatReservationRequest{
		ReservationId: "res-released",
		OrderId:       "order-1",
	})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
}
