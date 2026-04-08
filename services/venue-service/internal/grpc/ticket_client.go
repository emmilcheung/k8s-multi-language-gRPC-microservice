package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"time"

	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/sony/gobreaker/v2"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const ticketServiceReadTimeout = 5 * time.Second

var ErrTicketServiceUnavailable = errors.New("ticket-service unavailable")

var ErrTicketServiceTimeout = errors.New("ticket-service deadline exceeded")

type TicketLookupClient interface {
	GetTicket(ctx context.Context, in *ticketsv1.GetTicketRequest, opts ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error)
}

type resilientTicketClient struct {
	client  TicketLookupClient
	breaker *gobreaker.CircuitBreaker[*ticketsv1.GetTicketResponse]
}

func NewResilientTicketClient(client TicketLookupClient, log *zap.Logger) TicketLookupClient {
	if client == nil {
		return nil
	}

	settings := gobreaker.Settings{
		Name:        "ticket-service",
		Interval:    30 * time.Second,
		Timeout:     15 * time.Second,
		MaxRequests: 1,
		IsSuccessful: func(err error) bool {
			return !shouldCountTicketServiceFailure(err)
		},
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			if counts.Requests < 10 {
				return false
			}
			return float64(counts.TotalFailures)/float64(counts.Requests) >= 0.5
		},
		OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
			log.Warn("gRPC circuit breaker state changed",
				zap.String("dependency", name),
				zap.String("from", from.String()),
				zap.String("to", to.String()),
			)
		},
	}

	return &resilientTicketClient{
		client:  client,
		breaker: gobreaker.NewCircuitBreaker[*ticketsv1.GetTicketResponse](settings),
	}
}

func shouldCountTicketServiceFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}

	switch status.Code(err) {
	case codes.InvalidArgument,
		codes.NotFound,
		codes.AlreadyExists,
		codes.PermissionDenied,
		codes.FailedPrecondition,
		codes.OutOfRange,
		codes.Unauthenticated,
		codes.Canceled:
		return false
	default:
		return true
	}
}

func (c *resilientTicketClient) GetTicket(ctx context.Context, in *ticketsv1.GetTicketRequest, opts ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
	callCtx, cancel := context.WithTimeout(ctx, ticketServiceReadTimeout)
	defer cancel()

	resp, err := c.breaker.Execute(func() (*ticketsv1.GetTicketResponse, error) {
		return c.client.GetTicket(callCtx, in, opts...)
	})
	if err != nil {
		return nil, classifyTicketServiceError(err)
	}
	return resp, nil
}

func classifyTicketServiceError(err error) error {
	switch {
	case errors.Is(err, gobreaker.ErrOpenState), errors.Is(err, gobreaker.ErrTooManyRequests):
		return fmt.Errorf("%w: %v", ErrTicketServiceUnavailable, err)
	case errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%w: %v", ErrTicketServiceTimeout, err)
	}

	switch status.Code(err) {
	case codes.DeadlineExceeded:
		return fmt.Errorf("%w: %v", ErrTicketServiceTimeout, err)
	case codes.Unavailable:
		return fmt.Errorf("%w: %v", ErrTicketServiceUnavailable, err)
	default:
		return err
	}
}
