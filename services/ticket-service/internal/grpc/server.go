package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"net"
	"runtime/debug"
	"time"

	"github.com/acme/ticket-service/internal/grpc/tickets/v1"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
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

	return &v1.GetTicketResponse{
		TicketId:  ticket.ID,
		Title:     ticket.Title,
		Price:     ticket.Price,
		UserId:    ticket.UserID,
		OrderId:   ticket.OrderID,
		Version:   int64(ticket.Version),
		CreatedAt: timestamppb.New(ticket.CreatedAt),
		UpdatedAt: timestamppb.New(ticket.UpdatedAt),
	}, nil
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

	available := ticket.OrderID == ""
	if !available {
		s.log.Info("ticket is not available (already reserved)",
			zap.String("ticketId", req.TicketId),
			zap.String("orderId", ticket.OrderID),
		)
	}

	return &v1.ValidateTicketResponse{
		Available: available,
		TicketId:  ticket.ID,
		Price:     ticket.Price,
		Title:     ticket.Title,
	}, nil
}

// Start binds and starts the gRPC server on the given address. It blocks until
// the context is cancelled, then performs a graceful stop.
//
// Interceptors applied (R-08):
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
