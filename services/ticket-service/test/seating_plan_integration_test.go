package integration_test

import (
"context"
"encoding/json"
"net"
"net/http"
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

// ── gRPC ReserveQuota — seated ticket guard ────────────────────────────────

// TestGrpc_ReserveQuota_returns_FAILED_PRECONDITION_for_seated_ticket verifies
// that ReserveQuota rejects a request for a ticket that has a seating plan attached.
func TestGrpc_ReserveQuota_returns_FAILED_PRECONDITION_for_seated_ticket(t *testing.T) {
ctx := context.Background()

mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
require.NoError(t, err)
defer mongoContainer.Terminate(ctx) //nolint:errcheck

mongoURI, err := mongoContainer.ConnectionString(ctx)
require.NoError(t, err)

repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()+"_seated"))
require.NoError(t, err)
defer repo.Close(ctx) //nolint:errcheck

// Seed a ticket that has a seating plan attached.
err = repo.Create(ctx, &repository.Ticket{
ID:            "seated-ticket-1",
Title:         "Seated Concert",
Price:         "150",
UserID:        "organiser-1",
Quota:         100,
SeatingPlanID: "plan-uuid-seated",
TicketType:    "SEATED_MANUAL",
})
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

_, grpcErr := client.ReserveQuota(ctx2, &v1.ReserveQuotaRequest{
TicketId:      "seated-ticket-1",
ReservationId: "resv-seated-1",
UserId:        "buyer-1",
Quantity:      1,
})

require.Error(t, grpcErr)
assert.Equal(t, codes.FailedPrecondition, status.Code(grpcErr))
}

// ── Local helpers ─────────────────────────────────────────────────────────────

// decodeJSON decodes the response body as JSON into dst.
func decodeJSON(resp *http.Response, dst interface{}) error {
return json.NewDecoder(resp.Body).Decode(dst)
}
