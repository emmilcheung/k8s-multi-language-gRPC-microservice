package integration_test

// grpc_reservation_integration_test.go — CP-04
//
// Integration tests for the three new gRPC RPCs:
//   - ReserveQuota
//   - ReleaseReservation
//   - FinalizeReservation
//
// These tests use a MongoDB replica-set Testcontainer (required for transactions)
// and a real in-process gRPC server. All tests are guarded by testing.Short().

import (
	"context"
	"net"
	"net/url"
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
	"google.golang.org/protobuf/types/known/timestamppb"
)

// setupGrpcServerWithReplica starts a MongoDB replica-set container, wires a
// gRPC server backed by it, and returns the gRPC client + repo + cleanup func.
// Requires transactions → replica set.
func setupGrpcServerWithReplica(t *testing.T) (v1.TicketServiceClient, *repository.MongoTicketRepository, func()) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()

	mongoContainer, err := tcmongo.Run(ctx, "mongo:7", tcmongo.WithReplicaSet("rs0"))
	require.NoError(t, err, "start MongoDB replica-set container")

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)

	u, urlErr := url.Parse(mongoURI)
	require.NoError(t, urlErr)
	q := u.Query()
	q.Del("replicaSet")
	q.Set("directConnection", "true")
	u.RawQuery = q.Encode()
	mongoURI = u.String()

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()+"_cp04"))
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
	return client, repo, cleanup
}

// ── ReserveQuota ─────────────────────────────────────────────────────────────

func TestGrpc_ReserveQuota_succeeds_when_quota_available(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Seed a ticket with quota=5, maxPerUser=3.
	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "rq-ticket-1",
		Title:      "Reserve Me",
		Price:      "25.00",
		UserID:     "owner-1",
		Quota:      5,
		MaxPerUser: 3,
	}))

	resp, err := client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "rq-ticket-1",
		ReservationId: "resv-rq-1",
		UserId:        "buyer-1",
		Quantity:      2,
		ExpiresAt:     timestamppb.New(time.Now().Add(15 * time.Minute)),
	})
	require.NoError(t, err)
	assert.True(t, resp.GetSuccess())
	assert.Equal(t, "resv-rq-1", resp.GetReservationId())
	assert.Equal(t, "rq-ticket-1", resp.GetTicketId())
	assert.Equal(t, int32(2), resp.GetQuantity())
	assert.Equal(t, int32(3), resp.GetRemaining()) // 5 - 2 = 3
	assert.Equal(t, "Reserve Me", resp.GetTitle())
	assert.Equal(t, "25.00", resp.GetPrice())
	assert.Equal(t, int32(3), resp.GetMaxPerUser())
}

func TestGrpc_ReserveQuota_returns_RESOURCE_EXHAUSTED_when_sold_out(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Ticket with quota=1.
	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "rq-ticket-so",
		Title:      "Sold Out",
		Price:      "10.00",
		UserID:     "owner-so",
		Quota:      1,
		MaxPerUser: 1,
	}))

	// Reserve the only slot.
	require.NoError(t, repo.CreateReservation(ctx, &repository.TicketReservation{
		ID:       "resv-so-existing",
		TicketID: "rq-ticket-so",
		UserID:   "buyer-so-1",
		Quantity: 1,
	}))

	// A second buyer should get RESOURCE_EXHAUSTED.
	_, err := client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "rq-ticket-so",
		ReservationId: "resv-so-new",
		UserId:        "buyer-so-2",
		Quantity:      1,
	})
	require.Error(t, err)
	assert.Equal(t, codes.ResourceExhausted, status.Code(err))
}

func TestGrpc_ReserveQuota_returns_FAILED_PRECONDITION_when_per_user_limit_exceeded(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Ticket: quota=10, maxPerUser=1.
	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "rq-ticket-ulimit",
		Title:      "Per-user Limited",
		Price:      "5.00",
		UserID:     "owner-ul",
		Quota:      10,
		MaxPerUser: 1,
	}))

	// First reservation succeeds.
	_, err := client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "rq-ticket-ulimit",
		ReservationId: "resv-ul-1",
		UserId:        "buyer-ul",
		Quantity:      1,
	})
	require.NoError(t, err)

	// Second reservation for same user exceeds maxPerUser.
	_, err = client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "rq-ticket-ulimit",
		ReservationId: "resv-ul-2",
		UserId:        "buyer-ul",
		Quantity:      1,
	})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
}

func TestGrpc_ReserveQuota_returns_NOT_FOUND_for_unknown_ticket(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, _, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "does-not-exist",
		ReservationId: "resv-nf",
		UserId:        "buyer-nf",
		Quantity:      1,
	})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestGrpc_ReserveQuota_returns_INVALID_ARGUMENT_for_missing_fields(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, _, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tests := []struct {
		name string
		req  *v1.ReserveQuotaRequest
	}{
		{"missing ticket_id", &v1.ReserveQuotaRequest{ReservationId: "r1", UserId: "u1", Quantity: 1}},
		{"missing reservation_id", &v1.ReserveQuotaRequest{TicketId: "t1", UserId: "u1", Quantity: 1}},
		{"missing user_id", &v1.ReserveQuotaRequest{TicketId: "t1", ReservationId: "r1", Quantity: 1}},
		{"zero quantity", &v1.ReserveQuotaRequest{TicketId: "t1", ReservationId: "r1", UserId: "u1", Quantity: 0}},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.ReserveQuota(ctx, tc.req)
			require.Error(t, err)
			assert.Equal(t, codes.InvalidArgument, status.Code(err), "test: %s", tc.name)
		})
	}
}

// ── ReleaseReservation ────────────────────────────────────────────────────────

func TestGrpc_ReleaseReservation_succeeds_and_restores_quota(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "rel-ticket-1",
		Title:      "Releasable",
		Price:      "30.00",
		UserID:     "owner-rel",
		Quota:      3,
		MaxPerUser: 3,
	}))

	// Reserve then release.
	require.NoError(t, repo.CreateReservation(ctx, &repository.TicketReservation{
		ID:       "resv-rel-1",
		TicketID: "rel-ticket-1",
		UserID:   "buyer-rel",
		Quantity: 2,
	}))

	resp, err := client.ReleaseReservation(ctx, &v1.ReleaseReservationRequest{
		ReservationId: "resv-rel-1",
		Reason:        "CANCELLED",
	})
	require.NoError(t, err)
	assert.True(t, resp.GetSuccess())
	assert.Equal(t, "resv-rel-1", resp.GetReservationId())
	// After release quota is fully restored: remaining = 3 - 0 - 0 = 3.
	assert.Equal(t, int32(3), resp.GetRemaining())
}

func TestGrpc_ReleaseReservation_is_idempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "rel-ticket-idem",
		Title:      "Idempotent Release",
		Price:      "10.00",
		UserID:     "owner-ri",
		Quota:      2,
		MaxPerUser: 2,
	}))
	require.NoError(t, repo.CreateReservation(ctx, &repository.TicketReservation{
		ID:       "resv-rel-idem",
		TicketID: "rel-ticket-idem",
		UserID:   "buyer-ri",
		Quantity: 1,
	}))

	// Release twice — both must succeed.
	for i := 0; i < 2; i++ {
		resp, err := client.ReleaseReservation(ctx, &v1.ReleaseReservationRequest{
			ReservationId: "resv-rel-idem",
			Reason:        "CANCELLED",
		})
		require.NoError(t, err, "release attempt %d", i+1)
		assert.True(t, resp.GetSuccess())
	}
}

func TestGrpc_ReleaseReservation_returns_NOT_FOUND_for_unknown_id(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, _, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := client.ReleaseReservation(ctx, &v1.ReleaseReservationRequest{
		ReservationId: "does-not-exist",
		Reason:        "CANCELLED",
	})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestGrpc_ReleaseReservation_returns_INVALID_ARGUMENT_for_empty_id(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, _, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := client.ReleaseReservation(ctx, &v1.ReleaseReservationRequest{ReservationId: ""})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
}

// ── FinalizeReservation ───────────────────────────────────────────────────────

func TestGrpc_FinalizeReservation_succeeds_and_marks_sold(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "fin-ticket-1",
		Title:      "Finalizable",
		Price:      "99.00",
		UserID:     "owner-fin",
		Quota:      5,
		MaxPerUser: 2,
	}))
	require.NoError(t, repo.CreateReservation(ctx, &repository.TicketReservation{
		ID:       "resv-fin-1",
		TicketID: "fin-ticket-1",
		UserID:   "buyer-fin",
		Quantity: 2,
	}))

	resp, err := client.FinalizeReservation(ctx, &v1.FinalizeReservationRequest{
		ReservationId: "resv-fin-1",
		OrderId:       "order-fin-1",
	})
	require.NoError(t, err)
	assert.True(t, resp.GetSuccess())
	assert.Equal(t, "resv-fin-1", resp.GetReservationId())

	// Verify ticket counters: sold=2, reserved=0.
	ticket, err := repo.FindByID(ctx, "fin-ticket-1")
	require.NoError(t, err)
	assert.Equal(t, 2, ticket.Sold)
	assert.Equal(t, 0, ticket.Reserved)
}

func TestGrpc_FinalizeReservation_is_idempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "fin-ticket-idem",
		Title:      "Idempotent Finalize",
		Price:      "50.00",
		UserID:     "owner-fi",
		Quota:      3,
		MaxPerUser: 3,
	}))
	require.NoError(t, repo.CreateReservation(ctx, &repository.TicketReservation{
		ID:       "resv-fin-idem",
		TicketID: "fin-ticket-idem",
		UserID:   "buyer-fi",
		Quantity: 1,
	}))

	// Finalize twice — both must succeed without double-decrementing.
	for i := 0; i < 2; i++ {
		resp, err := client.FinalizeReservation(ctx, &v1.FinalizeReservationRequest{
			ReservationId: "resv-fin-idem",
			OrderId:       "order-fi-1",
		})
		require.NoError(t, err, "finalize attempt %d", i+1)
		assert.True(t, resp.GetSuccess())
	}

	// Counters should be correct after idempotent double-finalize.
	ticket, err := repo.FindByID(ctx, "fin-ticket-idem")
	require.NoError(t, err)
	assert.Equal(t, 1, ticket.Sold, "sold should be exactly 1 even after two finalizes")
	assert.Equal(t, 0, ticket.Reserved)
}

func TestGrpc_FinalizeReservation_returns_NOT_FOUND_for_unknown_id(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, _, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := client.FinalizeReservation(ctx, &v1.FinalizeReservationRequest{
		ReservationId: "does-not-exist",
		OrderId:       "order-x",
	})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

func TestGrpc_FinalizeReservation_returns_INVALID_ARGUMENT_for_missing_fields(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, _, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tests := []struct {
		name string
		req  *v1.FinalizeReservationRequest
	}{
		{"missing reservation_id", &v1.FinalizeReservationRequest{OrderId: "o1"}},
		{"missing order_id", &v1.FinalizeReservationRequest{ReservationId: "r1"}},
	}
	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.FinalizeReservation(ctx, tc.req)
			require.Error(t, err)
			assert.Equal(t, codes.InvalidArgument, status.Code(err), "test: %s", tc.name)
		})
	}
}

// ── Lifecycle: reserve → release → re-reserve ─────────────────────────────────

func TestGrpc_ReserveRelease_ReReserve_Cycle(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "cycle-ticket-1",
		Title:      "Cycle Ticket",
		Price:      "15.00",
		UserID:     "owner-cycle",
		Quota:      2,
		MaxPerUser: 2,
	}))

	// Reserve 1 slot.
	r1, err := client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "cycle-ticket-1",
		ReservationId: "resv-cycle-1",
		UserId:        "buyer-cycle",
		Quantity:      1,
	})
	require.NoError(t, err)
	assert.Equal(t, int32(1), r1.GetRemaining())

	// Cancel → release.
	rel, err := client.ReleaseReservation(ctx, &v1.ReleaseReservationRequest{
		ReservationId: "resv-cycle-1",
		Reason:        "CANCELLED",
	})
	require.NoError(t, err)
	assert.Equal(t, int32(2), rel.GetRemaining())

	// Re-reserve by different buyer.
	r2, err := client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "cycle-ticket-1",
		ReservationId: "resv-cycle-2",
		UserId:        "buyer-cycle-2",
		Quantity:      2,
	})
	require.NoError(t, err)
	assert.Equal(t, int32(0), r2.GetRemaining())
}

// ── Lifecycle: reserve → finalize (payment) ───────────────────────────────────

func TestGrpc_ReserveFinalize_SoldCounterIsCorrect(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	client, repo, cleanup := setupGrpcServerWithReplica(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	require.NoError(t, repo.Create(ctx, &repository.Ticket{
		ID:         "pay-ticket-1",
		Title:      "Payment Ticket",
		Price:      "200.00",
		UserID:     "owner-pay",
		Quota:      10,
		MaxPerUser: 5,
	}))

	// Reserve 3 slots.
	_, err := client.ReserveQuota(ctx, &v1.ReserveQuotaRequest{
		TicketId:      "pay-ticket-1",
		ReservationId: "resv-pay-1",
		UserId:        "buyer-pay",
		Quantity:      3,
	})
	require.NoError(t, err)

	// Payment complete → finalize.
	_, err = client.FinalizeReservation(ctx, &v1.FinalizeReservationRequest{
		ReservationId: "resv-pay-1",
		OrderId:       "order-pay-1",
	})
	require.NoError(t, err)

	// Validate: sold=3, reserved=0, available=7.
	ticket, err := repo.FindByID(ctx, "pay-ticket-1")
	require.NoError(t, err)
	assert.Equal(t, 3, ticket.Sold)
	assert.Equal(t, 0, ticket.Reserved)

	avail, availErr := client.ValidateTicketAvailability(ctx, &v1.ValidateTicketRequest{TicketId: "pay-ticket-1"})
	require.NoError(t, availErr)
	assert.True(t, avail.GetAvailable()) // quota(10) - reserved(0) - sold(3) = 7 > 0
}
