package integration_test

import (
	"context"
	"net"
	"testing"
	"time"

	grpcserver "github.com/acme/ticket-service/internal/grpc"
	"github.com/acme/ticket-service/internal/repository"
	v1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// setupGrpcServer starts a real MongoDB via Testcontainers, wires the gRPC server,
// and returns a connected gRPC client stub plus a cleanup function.
func setupGrpcServer(t *testing.T) (v1.TicketServiceClient, func()) {
	t.Helper()
	ctx := context.Background()

	mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err, "failed to start MongoDB container")

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()+"_grpc"))
	require.NoError(t, err)

	log := zap.NewNop()
	srv := grpcserver.NewTicketGrpcServer(repo, log)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	grpcSrv := grpc.NewServer()
	v1.RegisterTicketServiceServer(grpcSrv, srv)

	go func() { _ = grpcSrv.Serve(lis) }()

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)

	client := v1.NewTicketServiceClient(conn)

	cleanup := func() {
		grpcSrv.GracefulStop()
		_ = conn.Close()
		_ = repo.Close(ctx)
		_ = mongoContainer.Terminate(ctx)
	}
	return client, cleanup
}

// seedTicketViaGrpc creates a ticket directly in MongoDB so gRPC tests have data.
func seedGrpcTicket(t *testing.T, repo repository.TicketRepository, id, userID, title string, price string) {
	t.Helper()
	err := repo.Create(context.Background(), &repository.Ticket{
		ID:     id,
		Title:  title,
		Price:  price,
		UserID: userID,
	})
	require.NoError(t, err)
}

// ── GetTicket ─────────────────────────────────────────────────────────────────

func TestGrpc_GetTicket_returns_ticket_when_found(t *testing.T) {
	ctx := context.Background()

	mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err)
	defer mongoContainer.Terminate(ctx) //nolint:errcheck

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()+"_g"))
	require.NoError(t, err)
	defer repo.Close(ctx) //nolint:errcheck

	seedGrpcTicket(t, repo, "g-ticket-1", "user-1", "gRPC Ticket", "42")

	log := zap.NewNop()
	srv := grpcserver.NewTicketGrpcServer(repo, log)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	grpcSrv := grpc.NewServer()
	v1.RegisterTicketServiceServer(grpcSrv, srv)
	go func() { _ = grpcSrv.Serve(lis) }()
	defer grpcSrv.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	require.NoError(t, err)
	defer conn.Close() //nolint:errcheck

	client := v1.NewTicketServiceClient(conn)

	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := client.GetTicket(ctx2, &v1.GetTicketRequest{TicketId: "g-ticket-1"})
	require.NoError(t, err)
	assert.Equal(t, "g-ticket-1", resp.GetTicketId())
	assert.Equal(t, "gRPC Ticket", resp.GetTitle())
	assert.Equal(t, "42", resp.GetPrice())
	assert.Equal(t, "user-1", resp.GetUserId())
}

func TestGrpc_GetTicket_returns_NOT_FOUND_for_missing_ticket(t *testing.T) {
	client, cleanup := setupGrpcServer(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := client.GetTicket(ctx, &v1.GetTicketRequest{TicketId: "does-not-exist"})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestGrpc_GetTicket_returns_INVALID_ARGUMENT_for_empty_id(t *testing.T) {
	client, cleanup := setupGrpcServer(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := client.GetTicket(ctx, &v1.GetTicketRequest{TicketId: ""})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

// ── ValidateTicketAvailability ────────────────────────────────────────────────

func TestGrpc_ValidateTicketAvailability_returns_available_true_for_unreserved_ticket(t *testing.T) {
	ctx := context.Background()

	mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err)
	defer mongoContainer.Terminate(ctx) //nolint:errcheck

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()+"_v"))
	require.NoError(t, err)
	defer repo.Close(ctx) //nolint:errcheck

	seedGrpcTicket(t, repo, "g-avail-1", "user-2", "Available Ticket", "99")

	log := zap.NewNop()
	srv := grpcserver.NewTicketGrpcServer(repo, log)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	grpcSrv := grpc.NewServer()
	v1.RegisterTicketServiceServer(grpcSrv, srv)
	go func() { _ = grpcSrv.Serve(lis) }()
	defer grpcSrv.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	require.NoError(t, err)
	defer conn.Close() //nolint:errcheck

	client := v1.NewTicketServiceClient(conn)

	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := client.ValidateTicketAvailability(ctx2, &v1.ValidateTicketRequest{TicketId: "g-avail-1"})
	require.NoError(t, err)
	assert.True(t, resp.GetAvailable())
	assert.Equal(t, "g-avail-1", resp.GetTicketId())
	assert.Equal(t, "99", resp.GetPrice())
}

func TestGrpc_ValidateTicketAvailability_returns_available_false_for_reserved_ticket(t *testing.T) {
	ctx := context.Background()

	mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err)
	defer mongoContainer.Terminate(ctx) //nolint:errcheck

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()+"_r"))
	require.NoError(t, err)
	defer repo.Close(ctx) //nolint:errcheck

	seedGrpcTicket(t, repo, "g-reserved-1", "user-3", "Reserved Ticket", "50")
	err = repo.ReserveTicket(ctx, "g-reserved-1", "order-xyz")
	require.NoError(t, err)

	log := zap.NewNop()
	srv := grpcserver.NewTicketGrpcServer(repo, log)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	grpcSrv := grpc.NewServer()
	v1.RegisterTicketServiceServer(grpcSrv, srv)
	go func() { _ = grpcSrv.Serve(lis) }()
	defer grpcSrv.GracefulStop()

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	require.NoError(t, err)
	defer conn.Close() //nolint:errcheck

	client := v1.NewTicketServiceClient(conn)

	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := client.ValidateTicketAvailability(ctx2, &v1.ValidateTicketRequest{TicketId: "g-reserved-1"})
	require.NoError(t, err)
	assert.False(t, resp.GetAvailable())
}

func TestGrpc_ValidateTicketAvailability_returns_NOT_FOUND_for_missing_ticket(t *testing.T) {
	client, cleanup := setupGrpcServer(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := client.ValidateTicketAvailability(ctx, &v1.ValidateTicketRequest{TicketId: "no-such-ticket"})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestGrpc_ValidateTicketAvailability_returns_INVALID_ARGUMENT_for_empty_id(t *testing.T) {
	client, cleanup := setupGrpcServer(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := client.ValidateTicketAvailability(ctx, &v1.ValidateTicketRequest{TicketId: ""})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}
