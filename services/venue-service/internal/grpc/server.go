package grpcserver

import (
	"context"
	"fmt"
	"net"
	"runtime/debug"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// VenueGrpcServer implements the generated VenueServiceServer interface.
// CP-07 delivers the skeleton only — all RPCs return UNIMPLEMENTED and will be
// filled in during CP-10 (Seated Reservation Lifecycle).
type VenueGrpcServer struct {
	venuev1.UnimplementedVenueServiceServer
	reservationRepo repository.ReservationRepository
	sectionRepo     repository.SectionRepository
	planRepo        repository.PlanRepository
	log             *zap.Logger
}

// NewVenueGrpcServer creates a new gRPC server bound to the given repositories.
func NewVenueGrpcServer(
	reservationRepo repository.ReservationRepository,
	sectionRepo repository.SectionRepository,
	planRepo repository.PlanRepository,
	log *zap.Logger,
) *VenueGrpcServer {
	return &VenueGrpcServer{
		reservationRepo: reservationRepo,
		sectionRepo:     sectionRepo,
		planRepo:        planRepo,
		log:             log,
	}
}

// ReserveHeldSeats converts a set of held seats into a durable reservation.
// Fully implemented in CP-10; returns UNIMPLEMENTED for now.
func (s *VenueGrpcServer) ReserveHeldSeats(_ context.Context, _ *venuev1.ReserveHeldSeatsRequest) (*venuev1.ReserveHeldSeatsResponse, error) {
	return nil, status.Error(codes.Unimplemented, "ReserveHeldSeats not yet implemented — coming in CP-10")
}

// AutoAssignAndReserve selects the best available block and atomically reserves it.
// Fully implemented in CP-10/11.
func (s *VenueGrpcServer) AutoAssignAndReserve(_ context.Context, _ *venuev1.AutoAssignAndReserveRequest) (*venuev1.AutoAssignAndReserveResponse, error) {
	return nil, status.Error(codes.Unimplemented, "AutoAssignAndReserve not yet implemented — coming in CP-11")
}

// ReleaseSeatReservation transitions a reservation RESERVED → RELEASED.
// Fully implemented in CP-10.
func (s *VenueGrpcServer) ReleaseSeatReservation(_ context.Context, _ *venuev1.ReleaseSeatReservationRequest) (*venuev1.ReleaseSeatReservationResponse, error) {
	return nil, status.Error(codes.Unimplemented, "ReleaseSeatReservation not yet implemented — coming in CP-10")
}

// FinalizeSeatReservation transitions a reservation RESERVED → SOLD.
// Fully implemented in CP-10.
func (s *VenueGrpcServer) FinalizeSeatReservation(_ context.Context, _ *venuev1.FinalizeSeatReservationRequest) (*venuev1.FinalizeSeatReservationResponse, error) {
	return nil, status.Error(codes.Unimplemented, "FinalizeSeatReservation not yet implemented — coming in CP-10")
}

// GetSeatingPlan returns the plan metadata including status and attached ticket.
// Fully implemented in CP-08.
func (s *VenueGrpcServer) GetSeatingPlan(ctx context.Context, req *venuev1.GetSeatingPlanRequest) (*venuev1.GetSeatingPlanResponse, error) {
	if req.PlanId == "" {
		return nil, status.Error(codes.InvalidArgument, "plan_id is required")
	}

	plan, err := s.planRepo.FindByID(ctx, req.PlanId)
	if err != nil {
		if err == repository.ErrPlanNotFound {
			return nil, status.Errorf(codes.NotFound, "seating plan not found: %s", req.PlanId)
		}
		s.log.Error("grpc GetSeatingPlan failed", zap.Error(err), zap.String("planId", req.PlanId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	return &venuev1.GetSeatingPlanResponse{
		PlanId:   plan.ID,
		TicketId: plan.TicketID,
		Status:   string(plan.Status),
	}, nil
}

// Start binds and starts the gRPC server on the given address. It blocks until
// the context is cancelled, then performs a graceful stop.
func Start(ctx context.Context, addr string, srv *VenueGrpcServer, log *zap.Logger) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("grpc listen %s: %w", addr, err)
	}

	recoveryHandler := func(p any) error {
		log.Error("gRPC handler panic",
			zap.Any("panic", p),
			zap.String("stack", string(debug.Stack())),
		)
		return status.Errorf(codes.Internal, "internal server error")
	}
	recoveryOpt := recovery.WithRecoveryHandler(recoveryHandler)

	loggingInterceptor := func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		start := time.Now()

		if dl, ok := ctx.Deadline(); ok && time.Now().After(dl) {
			log.Warn("gRPC request arrived with expired deadline",
				zap.String("method", info.FullMethod),
			)
			return nil, status.Errorf(codes.DeadlineExceeded, "deadline exceeded before handler started")
		}

		resp, err := handler(ctx, req)
		duration := time.Since(start)

		code := codes.OK
		if err != nil {
			code = status.Code(err)
		}

		logFn := log.Info
		if err != nil {
			logFn = log.Error
		}
		logFn("gRPC request",
			zap.String("method", info.FullMethod),
			zap.Duration("duration", duration),
			zap.String("code", code.String()),
			zap.Error(err),
		)
		return resp, err
	}

	grpcServer := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(
			loggingInterceptor,
			recovery.UnaryServerInterceptor(recoveryOpt),
		),
	)
	venuev1.RegisterVenueServiceServer(grpcServer, srv)

	log.Info("gRPC server listening", zap.String("addr", addr))

	errCh := make(chan error, 1)
	go func() {
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("stopping gRPC server")
		grpcServer.GracefulStop()
		return nil
	case err := <-errCh:
		return err
	}
}
