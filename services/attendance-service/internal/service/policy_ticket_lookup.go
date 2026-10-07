package service

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const defaultTicketLookupTimeout = 5 * time.Second

// TicketOwnerLookup resolves a ticket owner for organizer policy authorization.
type TicketOwnerLookup interface {
	LookupTicketOwner(ctx context.Context, ticketID string) (string, error)
}

type grpcTicketOwnerLookup struct {
	client  ticketsv1.TicketServiceClient
	timeout time.Duration
}

// NewGRPCTicketOwnershipLookup builds a lookup that also returns the owning account.
func NewGRPCTicketOwnershipLookup(client ticketsv1.TicketServiceClient, timeout time.Duration) TicketOwnershipLookup {
	if client == nil {
		return nil
	}
	if timeout <= 0 {
		timeout = defaultTicketLookupTimeout
	}
	return &grpcTicketOwnerLookup{client: client, timeout: timeout}
}

// NewGRPCTicketOwnerLookup builds a gRPC ticket owner lookup adapter.
func NewGRPCTicketOwnerLookup(client ticketsv1.TicketServiceClient, timeout time.Duration) TicketOwnerLookup {
	if client == nil {
		return nil
	}
	if timeout <= 0 {
		timeout = defaultTicketLookupTimeout
	}
	return &grpcTicketOwnerLookup{client: client, timeout: timeout}
}

func (l *grpcTicketOwnerLookup) LookupTicketOwner(ctx context.Context, ticketID string) (string, error) {
	owner, err := l.LookupTicketOwnership(ctx, ticketID)
	return owner.UserID, err
}

// LookupTicketOwnership returns the ticket's creator and owning account.
func (l *grpcTicketOwnerLookup) LookupTicketOwnership(ctx context.Context, ticketID string) (TicketOwner, error) {
	callCtx, cancel := context.WithTimeout(ctx, l.timeout)
	defer cancel()

	resp, err := l.client.GetTicket(callCtx, &ticketsv1.GetTicketRequest{TicketId: ticketID})
	if err != nil {
		switch status.Code(err) {
		case codes.NotFound:
			return TicketOwner{}, repository.ErrNotFound
		case codes.InvalidArgument:
			return TicketOwner{}, repository.ErrNotFound
		default:
			return TicketOwner{}, fmt.Errorf("ticket owner lookup failed: %w", err)
		}
	}
	if resp.GetUserId() == "" {
		return TicketOwner{}, repository.ErrNotFound
	}
	return TicketOwner{UserID: resp.GetUserId(), AccountID: resp.GetAccountId()}, nil
}
