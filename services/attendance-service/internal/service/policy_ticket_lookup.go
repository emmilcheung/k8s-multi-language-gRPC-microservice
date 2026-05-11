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
	callCtx, cancel := context.WithTimeout(ctx, l.timeout)
	defer cancel()

	resp, err := l.client.GetTicket(callCtx, &ticketsv1.GetTicketRequest{TicketId: ticketID})
	if err != nil {
		switch status.Code(err) {
		case codes.NotFound:
			return "", repository.ErrNotFound
		case codes.InvalidArgument:
			return "", repository.ErrNotFound
		default:
			return "", fmt.Errorf("ticket owner lookup failed: %w", err)
		}
	}
	if resp.GetUserId() == "" {
		return "", repository.ErrNotFound
	}
	return resp.GetUserId(), nil
}
