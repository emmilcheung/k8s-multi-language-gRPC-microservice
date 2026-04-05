package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"net"
	"runtime/debug"
	"time"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
	v1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// TicketGrpcServer implements the generated TicketServiceServer interface.
type TicketGrpcServer struct {
	v1.UnimplementedTicketServiceServer
	repo repository.TicketRepository
	log  *zap.Logger
}

// NewTicketGrpcServer creates a new gRPC server bound to the given repository.
func NewTicketGrpcServer(repo repository.TicketRepository, log *zap.Logger) *TicketGrpcServer {
	return &TicketGrpcServer{repo: repo, log: log}
}

// GetTicket returns the full ticket by ID.
func (s *TicketGrpcServer) GetTicket(ctx context.Context, req *v1.GetTicketRequest) (*v1.GetTicketResponse, error) {
	if req.TicketId == "" {
		return nil, status.Error(codes.InvalidArgument, "ticket_id is required")
	}

	ticket, err := s.repo.FindByID(ctx, req.TicketId)
	if err != nil {
		if errors.Is(err, repository.ErrTicketNotFound) {
			return nil, status.Errorf(codes.NotFound, "ticket not found: %s", req.TicketId)
		}
		s.log.Error("grpc GetTicket failed", zap.Error(err), zap.String("ticketId", req.TicketId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	resp := &v1.GetTicketResponse{
		TicketId:   ticket.ID,
		Title:      ticket.Title,
		Price:      ticket.Price,
		UserId:     ticket.UserID,
		OrderId:    ticket.OrderID,
		Version:    int64(ticket.Version),
		CreatedAt:  timestamppb.New(ticket.CreatedAt),
		UpdatedAt:  timestamppb.New(ticket.UpdatedAt),
		TicketType: ticket.TicketType, // WS3: populated when ticket is attached to seating plan
	}
	// WS8: Populate event data if present
	if ticket.Event != nil {
		resp.EventTitle = ticket.Event.Title
		resp.EventStartsAt = timestamppb.New(ticket.Event.StartsAt)
		if ticket.Event.EndsAt != nil {
			resp.EventEndsAt = timestamppb.New(*ticket.Event.EndsAt)
		}
		resp.EventImageUrl = ticket.Event.ImageURL
		resp.VenueName = ticket.Event.VenueName
		resp.VenueAddress = ticket.Event.VenueAddress
	}
	return resp, nil
}

// ValidateTicketAvailability checks whether a ticket exists and is not already reserved.
func (s *TicketGrpcServer) ValidateTicketAvailability(ctx context.Context, req *v1.ValidateTicketRequest) (*v1.ValidateTicketResponse, error) {
	if req.TicketId == "" {
		return nil, status.Error(codes.InvalidArgument, "ticket_id is required")
	}

	ticket, err := s.repo.FindByID(ctx, req.TicketId)
	if err != nil {
		if errors.Is(err, repository.ErrTicketNotFound) {
			return nil, status.Errorf(codes.NotFound, "ticket not found: %s", req.TicketId)
		}
		s.log.Error("grpc ValidateTicketAvailability failed", zap.Error(err), zap.String("ticketId", req.TicketId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	available := (ticket.Quota - ticket.Reserved - ticket.Sold) > 0
	if !available {
		s.log.Info("ticket is not available (quota exhausted)",
			zap.String("ticketId", req.TicketId),
			zap.Int("quota", ticket.Quota),
			zap.Int("reserved", ticket.Reserved),
			zap.Int("sold", ticket.Sold),
		)
	}

	return &v1.ValidateTicketResponse{
		Available: available,
		TicketId:  ticket.ID,
		Price:     ticket.Price,
		Title:     ticket.Title,
	}, nil
}

// ReserveQuota atomically reserves quota for a ticket and creates a durable
// reservation record keyed by the caller-supplied reservationId.
//
// gRPC status code mapping:
//   - INVALID_ARGUMENT  — missing required fields
//   - NOT_FOUND         — ticket does not exist
//   - ALREADY_EXISTS    — reservationId is already used (idempotent: same params → OK)
//   - RESOURCE_EXHAUSTED — quota is insufficient (sold out)
//   - FAILED_PRECONDITION — per-user limit exceeded
//   - INTERNAL          — unexpected storage error
func (s *TicketGrpcServer) ReserveQuota(ctx context.Context, req *v1.ReserveQuotaRequest) (*v1.ReserveQuotaResponse, error) {
	if req.TicketId == "" {
		return nil, status.Error(codes.InvalidArgument, "ticket_id is required")
	}
	if req.ReservationId == "" {
		return nil, status.Error(codes.InvalidArgument, "reservation_id is required")
	}
	if req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, "user_id is required")
	}
	if req.Quantity < 1 {
		return nil, status.Error(codes.InvalidArgument, "quantity must be >= 1")
	}

	// Resolve expiry from request or default to 15 minutes.
	var expiresAt *time.Time
	if req.ExpiresAt != nil {
		t := req.ExpiresAt.AsTime()
		expiresAt = &t
	} else {
		t := time.Now().UTC().Add(15 * time.Minute)
		expiresAt = &t
	}

	// Look up the ticket first so we can return ticket metadata in the response.
	ticket, err := s.repo.FindByID(ctx, req.TicketId)
	if err != nil {
		if errors.Is(err, repository.ErrTicketNotFound) {
			return nil, status.Errorf(codes.NotFound, "ticket not found: %s", req.TicketId)
		}
		s.log.Error("grpc ReserveQuota: FindByID failed", zap.Error(err), zap.String("ticketId", req.TicketId))
		return nil, status.Error(codes.Internal, "internal error")
	}

	// CP-13: seated tickets must not be reserved via the GA quota path.
	// Callers must use the venue-service seated reservation endpoint instead.
	if ticket.SeatingPlanID != "" {
		s.log.Info("grpc ReserveQuota: rejected for seated ticket",
			zap.String("ticketId", req.TicketId),
			zap.String("seatingPlanId", ticket.SeatingPlanID),
		)
		return nil, status.Errorf(codes.FailedPrecondition,
			"ticket %s is a seated ticket — use the venue-service reservation path", req.TicketId)
	}

	resv := &repository.TicketReservation{
		ID:        req.ReservationId,
		TicketID:  req.TicketId,
		UserID:    req.UserId,
		Quantity:  int(req.Quantity),
		ExpiresAt: expiresAt,
	}

	if err := s.repo.CreateReservation(ctx, resv); err != nil {
		switch {
		case errors.Is(err, repository.ErrTicketNotFound):
			return nil, status.Errorf(codes.NotFound, "ticket not found: %s", req.TicketId)
		case errors.Is(err, repository.ErrInsufficientQuota):
			s.log.Info("grpc ReserveQuota: quota insufficient",
				zap.String("ticketId", req.TicketId),
				zap.String("reservationId", req.ReservationId),
				zap.Int32("requested", req.Quantity),
			)
			return nil, status.Errorf(codes.ResourceExhausted, "insufficient quota for ticket %s", req.TicketId)
		case errors.Is(err, repository.ErrPerUserLimitExceeded):
			s.log.Info("grpc ReserveQuota: per-user limit exceeded",
				zap.String("ticketId", req.TicketId),
				zap.String("userId", req.UserId),
			)
			return nil, status.Errorf(codes.FailedPrecondition, "per-user limit exceeded for ticket %s", req.TicketId)
		default:
			// Check if the duplicate key indicates the reservationId was already used.
			// We treat an existing RESERVED reservation with same id as idempotent success.
			existing, findErr := s.repo.FindReservationByID(ctx, req.ReservationId)
			if findErr == nil && existing.TicketID == req.TicketId && existing.UserID == req.UserId && existing.Quantity == int(req.Quantity) {
				s.log.Info("grpc ReserveQuota: idempotent duplicate accepted",
					zap.String("reservationId", req.ReservationId),
				)
				remaining := ticket.Quota - ticket.Reserved - ticket.Sold
				return &v1.ReserveQuotaResponse{
					Success:       true,
					ReservationId: existing.ID,
					TicketId:      ticket.ID,
					Quantity:      int32(existing.Quantity),
					Remaining:     int32(remaining),
					Title:         ticket.Title,
					Price:         ticket.Price,
					MaxPerUser:    int32(ticket.MaxPerUser),
				}, nil
			}
			s.log.Error("grpc ReserveQuota: CreateReservation failed",
				zap.Error(err),
				zap.String("ticketId", req.TicketId),
				zap.String("reservationId", req.ReservationId),
			)
			return nil, status.Error(codes.Internal, "internal error")
		}
	}

	// Recompute remaining after reservation.
	// We re-read the ticket to get the updated counters. If the read fails we
	// approximate from pre-reservation data so we always return success.
	remaining := int32(ticket.Quota - ticket.Reserved - ticket.Sold - int(req.Quantity))
	if updated, readErr := s.repo.FindByID(ctx, req.TicketId); readErr == nil {
		remaining = int32(updated.Quota - updated.Reserved - updated.Sold)
	}

	s.log.Info("grpc ReserveQuota: reservation created",
		zap.String("ticketId", req.TicketId),
		zap.String("reservationId", req.ReservationId),
		zap.String("userId", req.UserId),
		zap.Int32("quantity", req.Quantity),
		zap.Int32("remaining", remaining),
	)

	return &v1.ReserveQuotaResponse{
		Success:       true,
		ReservationId: req.ReservationId,
		TicketId:      ticket.ID,
		Quantity:      req.Quantity,
		Remaining:     remaining,
		Title:         ticket.Title,
		Price:         ticket.Price,
		MaxPerUser:    int32(ticket.MaxPerUser),
	}, nil
}

// ReleaseReservation transitions a reservation from RESERVED → RELEASED and
// restores quota availability. Idempotent: releasing an already-released
// reservation returns success.
//
// gRPC status code mapping:
//   - INVALID_ARGUMENT    — missing reservation_id
//   - NOT_FOUND           — reservation does not exist
//   - FAILED_PRECONDITION — reservation is already SOLD (cannot be released)
//   - INTERNAL            — unexpected storage error
func (s *TicketGrpcServer) ReleaseReservation(ctx context.Context, req *v1.ReleaseReservationRequest) (*v1.ReleaseReservationResponse, error) {
	if req.ReservationId == "" {
		return nil, status.Error(codes.InvalidArgument, "reservation_id is required")
	}

	if err := s.repo.ReleaseReservation(ctx, req.ReservationId); err != nil {
		switch {
		case errors.Is(err, repository.ErrReservationNotFound):
			return nil, status.Errorf(codes.NotFound, "reservation not found: %s", req.ReservationId)
		case errors.Is(err, repository.ErrReservationConflict):
			// Reservation is already SOLD — cannot release a sold reservation.
			return nil, status.Errorf(codes.FailedPrecondition, "reservation %s is already finalized (SOLD)", req.ReservationId)
		default:
			s.log.Error("grpc ReleaseReservation failed",
				zap.Error(err),
				zap.String("reservationId", req.ReservationId),
				zap.String("reason", req.Reason),
			)
			return nil, status.Error(codes.Internal, "internal error")
		}
	}

	// Best-effort: read ticket to return remaining count.
	var remaining int32
	if resv, err := s.repo.FindReservationByID(ctx, req.ReservationId); err == nil {
		if ticket, err := s.repo.FindByID(ctx, resv.TicketID); err == nil {
			remaining = int32(ticket.Quota - ticket.Reserved - ticket.Sold)
		}
	}

	s.log.Info("grpc ReleaseReservation: released",
		zap.String("reservationId", req.ReservationId),
		zap.String("reason", req.Reason),
	)

	return &v1.ReleaseReservationResponse{
		Success:       true,
		ReservationId: req.ReservationId,
		Remaining:     remaining,
	}, nil
}

// FinalizeReservation transitions a reservation from RESERVED → SOLD, records
// the orderId, and moves quantity from reserved to sold. Idempotent: finalizing
// an already-sold reservation returns success.
//
// gRPC status code mapping:
//   - INVALID_ARGUMENT    — missing reservation_id or order_id
//   - NOT_FOUND           — reservation does not exist
//   - FAILED_PRECONDITION — reservation is RELEASED (cannot finalize a released reservation)
//   - INTERNAL            — unexpected storage error
func (s *TicketGrpcServer) FinalizeReservation(ctx context.Context, req *v1.FinalizeReservationRequest) (*v1.FinalizeReservationResponse, error) {
	if req.ReservationId == "" {
		return nil, status.Error(codes.InvalidArgument, "reservation_id is required")
	}
	if req.OrderId == "" {
		return nil, status.Error(codes.InvalidArgument, "order_id is required")
	}

	if err := s.repo.FinalizeReservation(ctx, req.ReservationId, req.OrderId); err != nil {
		switch {
		case errors.Is(err, repository.ErrReservationNotFound):
			return nil, status.Errorf(codes.NotFound, "reservation not found: %s", req.ReservationId)
		case errors.Is(err, repository.ErrReservationConflict):
			// Reservation is RELEASED — cannot finalize.
			return nil, status.Errorf(codes.FailedPrecondition, "reservation %s is already released", req.ReservationId)
		default:
			s.log.Error("grpc FinalizeReservation failed",
				zap.Error(err),
				zap.String("reservationId", req.ReservationId),
				zap.String("orderId", req.OrderId),
			)
			return nil, status.Error(codes.Internal, "internal error")
		}
	}

	s.log.Info("grpc FinalizeReservation: finalized",
		zap.String("reservationId", req.ReservationId),
		zap.String("orderId", req.OrderId),
	)

	return &v1.FinalizeReservationResponse{
		Success:       true,
		ReservationId: req.ReservationId,
	}, nil
}

// Start binds and starts the gRPC server on the given address. It blocks until
// the context is cancelled, then performs a graceful stop.
//
// Interceptors and handlers applied (R-08, O-07):
//   - otelgrpc.NewServerHandler: propagates W3C traceparent from gRPC metadata
//     and creates server spans — makes every RPC part of the distributed trace.
//   - recovery: catches panics in handlers, logs a stack trace, returns INTERNAL to client.
//   - logging:  emits a structured JSON log line per RPC (method, duration, status code).
//   - deadline: logs a warning when the client deadline has already expired before the
//     handler runs, allowing early-exit with DEADLINE_EXCEEDED.
func Start(ctx context.Context, addr string, srv *TicketGrpcServer, log *zap.Logger) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("grpc listen %s: %w", addr, err)
	}

	// ── Recovery interceptor ──────────────────────────────────────────────────
	// Catches any panic inside a handler, logs the stack trace, and returns
	// INTERNAL to the client instead of crashing the process.
	recoveryHandler := func(p any) error {
		log.Error("gRPC handler panic",
			zap.Any("panic", p),
			zap.String("stack", string(debug.Stack())),
		)
		return status.Errorf(codes.Internal, "internal server error")
	}
	recoveryOpt := recovery.WithRecoveryHandler(recoveryHandler)

	// ── Logging interceptor ───────────────────────────────────────────────────
	// Emits one structured log line per RPC with method, duration, and status code.
	loggingInterceptor := func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		start := time.Now()

		// Enforce deadline: if the client deadline has already passed before we
		// even start handling, return DEADLINE_EXCEEDED immediately.
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
		// OTel trace propagation: extracts W3C traceparent from incoming gRPC
		// metadata and starts a server span for every RPC (O-07).
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
		grpc.ChainUnaryInterceptor(
			// Logging first so we always capture timing even if recovery fires
			loggingInterceptor,
			recovery.UnaryServerInterceptor(recoveryOpt),
		),
	)
	v1.RegisterTicketServiceServer(grpcServer, srv)

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
