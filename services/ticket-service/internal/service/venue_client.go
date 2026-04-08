package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/sony/gobreaker/v2"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const venueServiceReadTimeout = 5 * time.Second

type resilientVenueClient struct {
	client  SeatingPlanLookupClient
	breaker *gobreaker.CircuitBreaker[*venuev1.GetSeatingPlanResponse]
}

func NewResilientVenueClient(client SeatingPlanLookupClient, log *zap.Logger) SeatingPlanLookupClient {
	if client == nil {
		return nil
	}

	settings := gobreaker.Settings{
		Name:        "venue-service",
		Interval:    30 * time.Second,
		Timeout:     15 * time.Second,
		MaxRequests: 1,
		IsSuccessful: func(err error) bool {
			return !shouldCountVenueServiceFailure(err)
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

	return &resilientVenueClient{
		client:  client,
		breaker: gobreaker.NewCircuitBreaker[*venuev1.GetSeatingPlanResponse](settings),
	}
}

func shouldCountVenueServiceFailure(err error) bool {
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

func (c *resilientVenueClient) GetSeatingPlan(ctx context.Context, in *venuev1.GetSeatingPlanRequest, opts ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
	callCtx, cancel := context.WithTimeout(ctx, venueServiceReadTimeout)
	defer cancel()

	resp, err := c.breaker.Execute(func() (*venuev1.GetSeatingPlanResponse, error) {
		return c.client.GetSeatingPlan(callCtx, in, opts...)
	})
	if err != nil {
		return nil, classifyVenueServiceError(err)
	}
	return resp, nil
}

func classifyVenueServiceError(err error) error {
	switch {
	case errors.Is(err, gobreaker.ErrOpenState), errors.Is(err, gobreaker.ErrTooManyRequests):
		return fmt.Errorf("%w: %v", ErrVenueServiceUnavailable, err)
	case errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%w: %v", ErrVenueServiceTimeout, err)
	}

	switch status.Code(err) {
	case codes.DeadlineExceeded:
		return fmt.Errorf("%w: %v", ErrVenueServiceTimeout, err)
	case codes.Unavailable:
		return fmt.Errorf("%w: %v", ErrVenueServiceUnavailable, err)
	default:
		return err
	}
}
