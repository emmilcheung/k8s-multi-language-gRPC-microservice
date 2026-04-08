package grpcserver

import (
	"context"
	"testing"

	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type stubTicketLookupClient struct {
	calls int
	getFn func(ctx context.Context, in *ticketsv1.GetTicketRequest, opts ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error)
}

func (s *stubTicketLookupClient) GetTicket(ctx context.Context, in *ticketsv1.GetTicketRequest, opts ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
	s.calls++
	if s.getFn != nil {
		return s.getFn(ctx, in, opts...)
	}
	return &ticketsv1.GetTicketResponse{TicketId: in.TicketId}, nil
}

func TestResilientTicketClient_ShouldClassifyUnavailable(t *testing.T) {
	stub := &stubTicketLookupClient{
		getFn: func(context.Context, *ticketsv1.GetTicketRequest, ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
			return nil, status.Error(codes.Unavailable, "dependency unavailable")
		},
	}

	client := NewResilientTicketClient(stub, zap.NewNop())
	_, err := client.GetTicket(context.Background(), &ticketsv1.GetTicketRequest{TicketId: "ticket-1"})

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTicketServiceUnavailable)
	assert.Equal(t, 1, stub.calls)
}

func TestResilientTicketClient_ShouldClassifyTimeout(t *testing.T) {
	stub := &stubTicketLookupClient{
		getFn: func(context.Context, *ticketsv1.GetTicketRequest, ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
			return nil, status.Error(codes.DeadlineExceeded, "dependency timeout")
		},
	}

	client := NewResilientTicketClient(stub, zap.NewNop())
	_, err := client.GetTicket(context.Background(), &ticketsv1.GetTicketRequest{TicketId: "ticket-1"})

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrTicketServiceTimeout)
	assert.Equal(t, 1, stub.calls)
}

func TestResilientTicketClient_ShouldNotTripBreakerOnNotFound(t *testing.T) {
	stub := &stubTicketLookupClient{
		getFn: func(context.Context, *ticketsv1.GetTicketRequest, ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
			return nil, status.Error(codes.NotFound, "ticket not found")
		},
	}

	client := NewResilientTicketClient(stub, zap.NewNop())
	for attempt := 0; attempt < 20; attempt++ {
		_, err := client.GetTicket(context.Background(), &ticketsv1.GetTicketRequest{TicketId: "missing-ticket"})
		require.Error(t, err)
		assert.Equal(t, codes.NotFound, status.Code(err))
		assert.NotErrorIs(t, err, ErrTicketServiceUnavailable)
	}

	assert.Equal(t, 20, stub.calls)
}
