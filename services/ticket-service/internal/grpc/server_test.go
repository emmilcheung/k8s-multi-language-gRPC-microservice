package grpcserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/acme/ticket-service/internal/repository"
	v1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// dupRepo simulates a CreateReservation that hits a duplicate reservationId.
type dupRepo struct {
	repository.TicketRepository
	createErr error
	existing  *repository.TicketReservation
}

func (r *dupRepo) FindByID(context.Context, string) (*repository.Ticket, error) {
	return &repository.Ticket{ID: "t1", Quota: 10, MaxPerUser: 4}, nil
}

func (r *dupRepo) CreateReservation(context.Context, *repository.TicketReservation) error {
	return r.createErr
}

func (r *dupRepo) FindReservationByID(context.Context, string) (*repository.TicketReservation, error) {
	return r.existing, nil
}

func reserve(t *testing.T, repo *dupRepo) (*v1.ReserveQuotaResponse, error) {
	t.Helper()
	s := NewTicketGrpcServer(repo, zap.NewNop())
	return s.ReserveQuota(context.Background(), &v1.ReserveQuotaRequest{
		TicketId: "t1", ReservationId: "r1", UserId: "u1", Quantity: 2,
	})
}

func existing(st repository.ReservationStatus) *repository.TicketReservation {
	return &repository.TicketReservation{ID: "r1", TicketID: "t1", UserID: "u1", Quantity: 2, Status: st}
}

// C-8: an Idempotency-Key retry may reuse only a live reservation. Accepting a dead one
// would let order-service create an order on inventory that is no longer held (oversell).
func TestReserveQuota_DuplicateReserved_IsIdempotentSuccess(t *testing.T) {
	resp, err := reserve(t, &dupRepo{createErr: errors.New("E11000 duplicate key"), existing: existing(repository.ReservationStatusReserved)})
	if err != nil || !resp.Success {
		t.Fatalf("want idempotent success, got resp=%v err=%v", resp, err)
	}
}

func TestReserveQuota_DuplicateNotReserved_IsFailedPreconditionWithPrefix(t *testing.T) {
	for _, st := range []repository.ReservationStatus{
		repository.ReservationStatusReleased, repository.ReservationStatusExpired, repository.ReservationStatusSold,
	} {
		t.Run(string(st), func(t *testing.T) {
			_, err := reserve(t, &dupRepo{createErr: errors.New("E11000 duplicate key"), existing: existing(st)})
			if status.Code(err) != codes.FailedPrecondition {
				t.Fatalf("want FailedPrecondition, got %v", err)
			}
			if !strings.HasPrefix(status.Convert(err).Message(), ReservationInactivePrefix) {
				t.Fatalf("message %q lacks prefix %q", status.Convert(err).Message(), ReservationInactivePrefix)
			}
		})
	}
}

// order-service tells this signal apart from the purchase-limit 422 by prefix; the two must not collide.
func TestReserveQuota_PurchaseLimitMessage_DoesNotCarryInactivePrefix(t *testing.T) {
	_, err := reserve(t, &dupRepo{createErr: repository.ErrPerUserLimitExceeded})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("want FailedPrecondition, got %v", err)
	}
	if strings.HasPrefix(status.Convert(err).Message(), ReservationInactivePrefix) {
		t.Fatalf("purchase-limit message must not start with the inactive prefix: %q", status.Convert(err).Message())
	}
}

// Contract with order-service TicketServiceClient.RESERVATION_INACTIVE_PREFIX (copied literally there).
func TestReservationInactivePrefix_ContractValue(t *testing.T) {
	if ReservationInactivePrefix != "reservation no longer active: " {
		t.Fatalf("prefix changed to %q: update order-service TicketServiceClient.RESERVATION_INACTIVE_PREFIX and its contract test", ReservationInactivePrefix)
	}
}
