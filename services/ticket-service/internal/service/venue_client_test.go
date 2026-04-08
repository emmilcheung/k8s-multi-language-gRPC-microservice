package service

import (
	"context"
	"testing"

	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type stubSeatingPlanLookupClient struct {
	calls int
	getFn func(ctx context.Context, in *venuev1.GetSeatingPlanRequest, opts ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error)
}

func (s *stubSeatingPlanLookupClient) GetSeatingPlan(ctx context.Context, in *venuev1.GetSeatingPlanRequest, opts ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
	s.calls++
	if s.getFn != nil {
		return s.getFn(ctx, in, opts...)
	}
	return &venuev1.GetSeatingPlanResponse{PlanId: in.PlanId}, nil
}

func TestResilientVenueClient_ShouldClassifyUnavailable(t *testing.T) {
	stub := &stubSeatingPlanLookupClient{
		getFn: func(context.Context, *venuev1.GetSeatingPlanRequest, ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
			return nil, status.Error(codes.Unavailable, "dependency unavailable")
		},
	}

	client := NewResilientVenueClient(stub, zap.NewNop())
	_, err := client.GetSeatingPlan(context.Background(), &venuev1.GetSeatingPlanRequest{PlanId: "plan-1"})

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrVenueServiceUnavailable)
	assert.Equal(t, 1, stub.calls)
}

func TestResilientVenueClient_ShouldClassifyTimeout(t *testing.T) {
	stub := &stubSeatingPlanLookupClient{
		getFn: func(context.Context, *venuev1.GetSeatingPlanRequest, ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
			return nil, status.Error(codes.DeadlineExceeded, "dependency timeout")
		},
	}

	client := NewResilientVenueClient(stub, zap.NewNop())
	_, err := client.GetSeatingPlan(context.Background(), &venuev1.GetSeatingPlanRequest{PlanId: "plan-1"})

	require.Error(t, err)
	assert.ErrorIs(t, err, ErrVenueServiceTimeout)
	assert.Equal(t, 1, stub.calls)
}

func TestResilientVenueClient_ShouldNotTripBreakerOnNotFound(t *testing.T) {
	stub := &stubSeatingPlanLookupClient{
		getFn: func(context.Context, *venuev1.GetSeatingPlanRequest, ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
			return nil, status.Error(codes.NotFound, "plan not found")
		},
	}

	client := NewResilientVenueClient(stub, zap.NewNop())
	for attempt := 0; attempt < 20; attempt++ {
		_, err := client.GetSeatingPlan(context.Background(), &venuev1.GetSeatingPlanRequest{PlanId: "missing-plan"})
		require.Error(t, err)
		assert.Equal(t, codes.NotFound, status.Code(err))
		assert.NotErrorIs(t, err, ErrVenueServiceUnavailable)
	}

	assert.Equal(t, 20, stub.calls)
}
