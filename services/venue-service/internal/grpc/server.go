package grpcserver

import (
	"context"
	"fmt"
	"net"
	"runtime/debug"
	"time"

	"github.com/acme/venue-service/internal/autoassign"
	"github.com/acme/venue-service/internal/repository"
	"github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// VenueGrpcServer implements the generated VenueServiceServer interface.
// CP-10 implemented the seated reservation lifecycle RPCs.
// CP-11 implements AutoAssignAndReserve.
type VenueGrpcServer struct {
	venuev1.UnimplementedVenueServiceServer
	reservationRepo repository.ReservationRepository
	sectionRepo     repository.SectionRepository
	planRepo        repository.PlanRepository
	ticketClient    ticketsv1.TicketServiceClient
	log             *zap.Logger
}

// NewVenueGrpcServer creates a new gRPC server bound to the given repositories.
func NewVenueGrpcServer(
	reservationRepo repository.ReservationRepository,
	sectionRepo repository.SectionRepository,
	planRepo repository.PlanRepository,
	ticketClient ticketsv1.TicketServiceClient,
	log *zap.Logger,
) *VenueGrpcServer {
	return &VenueGrpcServer{
		reservationRepo: reservationRepo,
		sectionRepo:     sectionRepo,
		planRepo:        planRepo,
		ticketClient:    ticketClient,
		log:             log,
	}
}

// ReserveHeldSeats converts a set of held (or still-available) seats into a
// durable reservation keyed by reservationId.
//
// Idempotent: if the reservationId already exists and is RESERVED, success is
// returned immediately with the existing seat details.
func (s *VenueGrpcServer) ReserveHeldSeats(ctx context.Context, req *venuev1.ReserveHeldSeatsRequest) (*venuev1.ReserveHeldSeatsResponse, error) {
	if req.PlanId == "" || req.TicketId == "" || req.ReservationId == "" || req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, "plan_id, ticket_id, reservation_id, and user_id are required")
	}
	if len(req.SeatIds) == 0 {
		return nil, status.Error(codes.InvalidArgument, "seat_ids must not be empty")
	}

	// Idempotency: check whether a reservation for this ID already exists.
	existing, err := s.reservationRepo.FindReservationByID(ctx, req.ReservationId)
	if err == nil {
		switch existing.Status {
		case repository.ReservationStatusReserved:
			return &venuev1.ReserveHeldSeatsResponse{
				Success:       true,
				ReservationId: existing.ID,
				Seats:         toSeatDetails(existing.Items),
			}, nil
		case repository.ReservationStatusReleased, repository.ReservationStatusExpired:
			return nil, status.Errorf(codes.FailedPrecondition,
				"reservation %s was already released", req.ReservationId)
		case repository.ReservationStatusSold:
			return nil, status.Errorf(codes.FailedPrecondition,
				"reservation %s was already sold", req.ReservationId)
		}
	} else if err != repository.ErrReservationNotFound {
		s.log.Error("ReserveHeldSeats: lookup failed", zap.Error(err),
			zap.String("reservationId", req.ReservationId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	// Build the reservation domain object.
	var expiresAt *time.Time
	if req.ExpiresAt != nil {
		t := req.ExpiresAt.AsTime()
		expiresAt = &t
	}

	res := &repository.SeatReservation{
		ID:        req.ReservationId,
		PlanID:    req.PlanId,
		TicketID:  req.TicketId,
		UserID:    req.UserId,
		Status:    repository.ReservationStatusReserved,
		ExpiresAt: expiresAt,
		// SectionID is intentionally left empty for manual-pick reservations
		// spanning multiple sections; it is captured per-item.
	}

	// Fetch ticket price from ticket-service for price fallback resolution.
	ticketResp, err := s.ticketClient.GetTicket(ctx, &ticketsv1.GetTicketRequest{TicketId: req.TicketId})
	if err != nil {
		s.log.Error("ReserveHeldSeats: GetTicket failed", zap.Error(err),
			zap.String("ticketId", req.TicketId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	// Atomic: lock seats, transition HELD/AVAILABLE → RESERVED, write ledger.
	// ticketResp.Price is passed for price fallback resolution.
	if err := s.reservationRepo.AtomicReserveAndCreate(ctx, req.SeatIds, res, ticketResp.Price); err != nil {
		switch err {
		case repository.ErrSeatNotAvailable:
			// Return success=false with the full list so the caller can inspect.
			return &venuev1.ReserveHeldSeatsResponse{
				Success:            false,
				UnavailableSeatIds: req.SeatIds,
			}, nil
		case repository.ErrReservationAlreadyDone:
			// Concurrent duplicate — treat as idempotent success but reload items.
			if loaded, loadErr := s.reservationRepo.FindReservationByID(ctx, req.ReservationId); loadErr == nil {
				return &venuev1.ReserveHeldSeatsResponse{
					Success:       true,
					ReservationId: loaded.ID,
					Seats:         toSeatDetails(loaded.Items),
				}, nil
			}
			return &venuev1.ReserveHeldSeatsResponse{
				Success:       true,
				ReservationId: req.ReservationId,
			}, nil
		default:
			s.log.Error("ReserveHeldSeats: atomic reserve failed", zap.Error(err),
				zap.String("reservationId", req.ReservationId),
				zap.String("planId", req.PlanId))
			return nil, status.Error(codes.Internal, "internal error")
		}
	}

	return &venuev1.ReserveHeldSeatsResponse{
		Success:       true,
		ReservationId: res.ID,
		Seats:         toSeatDetails(res.Items),
	}, nil
}

// AutoAssignAndReserve selects the best available block of seats in the given
// section and atomically reserves them.
//
// Algorithm (§10 of venue-seating-plan-design.md):
//  1. Validate required fields.
//  2. Idempotency: if reservationId already exists and is RESERVED, return success.
//  3. Load all AVAILABLE seats in the section via GetAvailableSeatsInSection.
//  4. Run the auto-assign algorithm to find the best contiguous block.
//  5. Atomically reserve the chosen seats via AtomicReserveAndCreate.
//  6. Return success, reservationId, and snapshotted seat details.
func (s *VenueGrpcServer) AutoAssignAndReserve(ctx context.Context, req *venuev1.AutoAssignAndReserveRequest) (*venuev1.AutoAssignAndReserveResponse, error) {
	if req.PlanId == "" || req.TicketId == "" || req.SectionId == "" || req.ReservationId == "" || req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument,
			"plan_id, ticket_id, section_id, reservation_id, and user_id are required")
	}
	if req.Quantity <= 0 {
		return nil, status.Error(codes.InvalidArgument, "quantity must be greater than zero")
	}

	// Idempotency: check whether a reservation for this ID already exists.
	existing, err := s.reservationRepo.FindReservationByID(ctx, req.ReservationId)
	if err == nil {
		switch existing.Status {
		case repository.ReservationStatusReserved:
			return &venuev1.AutoAssignAndReserveResponse{
				Success:       true,
				ReservationId: existing.ID,
				Seats:         toSeatDetails(existing.Items),
			}, nil
		case repository.ReservationStatusReleased, repository.ReservationStatusExpired:
			return nil, status.Errorf(codes.FailedPrecondition,
				"reservation %s was already released", req.ReservationId)
		case repository.ReservationStatusSold:
			return nil, status.Errorf(codes.FailedPrecondition,
				"reservation %s was already sold", req.ReservationId)
		}
	} else if err != repository.ErrReservationNotFound {
		s.log.Error("AutoAssignAndReserve: lookup failed", zap.Error(err),
			zap.String("reservationId", req.ReservationId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	// Load available seats in the section.
	availableSeats, err := s.sectionRepo.GetAvailableSeatsInSection(ctx, req.SectionId)
	if err != nil {
		if err == repository.ErrSectionNotFound {
			return nil, status.Errorf(codes.NotFound, "section not found: %s", req.SectionId)
		}
		s.log.Error("AutoAssignAndReserve: GetAvailableSeatsInSection failed", zap.Error(err),
			zap.String("sectionId", req.SectionId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	// Run the auto-assign algorithm.
	chosenSeatIDs, err := autoassign.FindBestBlock(availableSeats, int(req.Quantity))
	if err != nil {
		if err == autoassign.ErrNotEnoughSeats {
			return &venuev1.AutoAssignAndReserveResponse{
				Success: false,
			}, nil
		}
		s.log.Error("AutoAssignAndReserve: FindBestBlock failed", zap.Error(err))
		return nil, status.Error(codes.Internal, "internal error")
	}

	// Build reservation domain object.
	var expiresAt *time.Time
	if req.ExpiresAt != nil {
		t := req.ExpiresAt.AsTime()
		expiresAt = &t
	}

	res := &repository.SeatReservation{
		ID:        req.ReservationId,
		PlanID:    req.PlanId,
		TicketID:  req.TicketId,
		UserID:    req.UserId,
		SectionID: req.SectionId,
		Status:    repository.ReservationStatusReserved,
		ExpiresAt: expiresAt,
	}

	// Fetch ticket price from ticket-service for price fallback resolution.
	ticketResp, err := s.ticketClient.GetTicket(ctx, &ticketsv1.GetTicketRequest{TicketId: req.TicketId})
	if err != nil {
		s.log.Error("AutoAssignAndReserve: GetTicket failed", zap.Error(err),
			zap.String("ticketId", req.TicketId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	// Atomic: lock seats, transition AVAILABLE → RESERVED, write ledger.
	// ticketResp.Price is passed for price fallback resolution.
	if err := s.reservationRepo.AtomicReserveAndCreate(ctx, chosenSeatIDs, res, ticketResp.Price); err != nil {
		switch err {
		case repository.ErrSeatNotAvailable:
			// Race condition — seats were taken between query and reserve.
			return &venuev1.AutoAssignAndReserveResponse{
				Success: false,
			}, nil
		case repository.ErrReservationAlreadyDone:
			// Concurrent duplicate — reload and return success idempotently.
			if loaded, loadErr := s.reservationRepo.FindReservationByID(ctx, req.ReservationId); loadErr == nil {
				return &venuev1.AutoAssignAndReserveResponse{
					Success:       true,
					ReservationId: loaded.ID,
					Seats:         toSeatDetails(loaded.Items),
				}, nil
			}
			return &venuev1.AutoAssignAndReserveResponse{
				Success:       true,
				ReservationId: req.ReservationId,
			}, nil
		default:
			s.log.Error("AutoAssignAndReserve: atomic reserve failed", zap.Error(err),
				zap.String("reservationId", req.ReservationId),
				zap.String("planId", req.PlanId))
			return nil, status.Error(codes.Internal, "internal error")
		}
	}

	s.log.Info("AutoAssignAndReserve: reservation created",
		zap.String("reservationId", res.ID),
		zap.String("planId", req.PlanId),
		zap.String("sectionId", req.SectionId),
		zap.Int32("quantity", req.Quantity),
	)

	return &venuev1.AutoAssignAndReserveResponse{
		Success:       true,
		ReservationId: res.ID,
		Seats:         toSeatDetails(res.Items),
	}, nil
}

// ReleaseSeatReservation transitions a reservation RESERVED → RELEASED and
// restores seats to AVAILABLE.
//
// Idempotent: already-released reservations return success.
func (s *VenueGrpcServer) ReleaseSeatReservation(ctx context.Context, req *venuev1.ReleaseSeatReservationRequest) (*venuev1.ReleaseSeatReservationResponse, error) {
	if req.ReservationId == "" {
		return nil, status.Error(codes.InvalidArgument, "reservation_id is required")
	}

	if err := s.reservationRepo.ReleaseReservation(ctx, req.ReservationId, req.Reason); err != nil {
		switch err {
		case repository.ErrReservationAlreadyDone:
			// Already released — idempotent success.
			return &venuev1.ReleaseSeatReservationResponse{Success: true}, nil
		case repository.ErrReservationNotFound:
			return nil, status.Errorf(codes.NotFound, "reservation not found: %s", req.ReservationId)
		case repository.ErrReservationConflict:
			return nil, status.Errorf(codes.FailedPrecondition,
				"reservation %s is already sold and cannot be released", req.ReservationId)
		default:
			s.log.Error("ReleaseSeatReservation failed", zap.Error(err),
				zap.String("reservationId", req.ReservationId))
			return nil, status.Error(codes.Internal, "internal error")
		}
	}

	s.log.Info("ReleaseSeatReservation: reservation released",
		zap.String("reservationId", req.ReservationId),
		zap.String("reason", req.Reason))
	return &venuev1.ReleaseSeatReservationResponse{Success: true}, nil
}

// FinalizeSeatReservation transitions a reservation RESERVED → SOLD and
// records the orderId.
//
// Idempotent: already-sold reservations return success.
func (s *VenueGrpcServer) FinalizeSeatReservation(ctx context.Context, req *venuev1.FinalizeSeatReservationRequest) (*venuev1.FinalizeSeatReservationResponse, error) {
	if req.ReservationId == "" || req.OrderId == "" {
		return nil, status.Error(codes.InvalidArgument, "reservation_id and order_id are required")
	}

	if err := s.reservationRepo.FinalizeReservation(ctx, req.ReservationId, req.OrderId); err != nil {
		switch err {
		case repository.ErrReservationAlreadyDone:
			// Already sold — idempotent success.
			return &venuev1.FinalizeSeatReservationResponse{Success: true}, nil
		case repository.ErrReservationNotFound:
			return nil, status.Errorf(codes.NotFound, "reservation not found: %s", req.ReservationId)
		case repository.ErrReservationConflict:
			return nil, status.Errorf(codes.FailedPrecondition,
				"reservation %s was released and cannot be finalized", req.ReservationId)
		default:
			s.log.Error("FinalizeSeatReservation failed", zap.Error(err),
				zap.String("reservationId", req.ReservationId),
				zap.String("orderId", req.OrderId))
			return nil, status.Error(codes.Internal, "internal error")
		}
	}

	s.log.Info("FinalizeSeatReservation: reservation finalized",
		zap.String("reservationId", req.ReservationId),
		zap.String("orderId", req.OrderId))
	return &venuev1.FinalizeSeatReservationResponse{Success: true}, nil
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
		PlanId:         plan.ID,
		TicketId:       plan.TicketID,
		Status:         string(plan.Status),
		AssignmentMode: plan.AssignmentMode,
		PricingMode:    plan.PricingMode,
	}, nil
}

// toSeatDetails converts reservation items into the proto SeatDetail slice.
func toSeatDetails(items []repository.SeatReservationItem) []*venuev1.SeatDetail {
	details := make([]*venuev1.SeatDetail, len(items))
	for i, item := range items {
		details[i] = &venuev1.SeatDetail{
			SeatId:    item.SeatID,
			SectionId: item.SectionID,
			SeatLabel: item.SeatLabel,
			Price:     item.Price,
		}
	}
	return details
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
