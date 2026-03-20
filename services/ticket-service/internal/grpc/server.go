package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"net"

	"github.com/acme/ticket-service/internal/grpc/tickets/v1"
	"github.com/acme/ticket-service/internal/repository"
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
func Start(ctx context.Context, addr string, srv *TicketGrpcServer, log *zap.Logger) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("grpc listen %s: %w", addr, err)
	}

	grpcServer := grpc.NewServer()
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
