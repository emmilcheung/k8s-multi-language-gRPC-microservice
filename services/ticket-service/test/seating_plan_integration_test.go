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

// ── Seating plan HTTP endpoints ───────────────────────────────────────────────

// TestAttachSeatingPlan_ShouldReturn200AndSetSeatingPlanId verifies that a
// ticket owner can attach a seating plan and the response contains the plan ID.
func TestAttachSeatingPlan_ShouldReturn200AndSetSeatingPlanId(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	// Create a ticket owned by "owner-user".
	createResp, ticketID := createTicket(t, ts.URL, "Seated Concert", "99.99", "owner-user")
	require.Equal(t, http.StatusCreated, createResp)

	// Attach a seating plan.
	planID := "550e8400-e29b-41d4-a716-446655440000"
	body := jsonBody(t, map[string]interface{}{"seatingPlanId": planID})
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/tickets/"+ticketID+"/seating-plan", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "owner-user")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close() //nolint:errcheck

	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var result map[string]interface{}
	require.NoError(t, decodeJSON(resp, &result))
	assert.Equal(t, planID, result["seatingPlanId"])
	assert.Equal(t, ticketID, result["id"])
}

// TestAttachSeatingPlan_ShouldReturn200OnGet verifies that GET after attach
// returns the seatingPlanId field in the ticket body.
func TestAttachSeatingPlan_ShouldReturn200OnGet(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	_, ticketID := createTicket(t, ts.URL, "Seated Concert", "99.99", "owner-user")

	planID := "660e8400-e29b-41d4-a716-446655440001"
	attachSeatingPlan(t, ts.URL, ticketID, planID, "owner-user", http.StatusOK)

	// GET should now include seatingPlanId.
	getReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/tickets/"+ticketID, nil)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer getResp.Body.Close() //nolint:errcheck

	assert.Equal(t, http.StatusOK, getResp.StatusCode)
	var ticket map[string]interface{}
	require.NoError(t, decodeJSON(getResp, &ticket))
	assert.Equal(t, planID, ticket["seatingPlanId"])
}

// TestAttachSeatingPlan_ThenDetach_ShouldClearSeatingPlanId verifies attach →
// detach → GET leaves no seatingPlanId on the ticket.
func TestAttachSeatingPlan_ThenDetach_ShouldClearSeatingPlanId(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	_, ticketID := createTicket(t, ts.URL, "Seated Concert", "99.99", "owner-user")

	planID := "770e8400-e29b-41d4-a716-446655440002"
	attachSeatingPlan(t, ts.URL, ticketID, planID, "owner-user", http.StatusOK)

	// Detach.
	delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/tickets/"+ticketID+"/seating-plan", nil)
	delReq.Header.Set("X-User-Id", "owner-user")
	delResp, err := http.DefaultClient.Do(delReq)
	require.NoError(t, err)
	defer delResp.Body.Close() //nolint:errcheck
	assert.Equal(t, http.StatusOK, delResp.StatusCode)

	// GET should have no seatingPlanId.
	getReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/tickets/"+ticketID, nil)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer getResp.Body.Close() //nolint:errcheck
	var ticket map[string]interface{}
	require.NoError(t, decodeJSON(getResp, &ticket))
	_, hasField := ticket["seatingPlanId"]
	assert.False(t, hasField, "seatingPlanId should be absent after detach")
}

// TestAttachSeatingPlan_ShouldReturn409WhenAlreadyAttached verifies that a
// second attach on the same ticket returns 409.
func TestAttachSeatingPlan_ShouldReturn409WhenAlreadyAttached(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	_, ticketID := createTicket(t, ts.URL, "Seated Concert", "99.99", "owner-user")
	attachSeatingPlan(t, ts.URL, ticketID, "880e8400-e29b-41d4-a716-446655440010", "owner-user", http.StatusOK)
	attachSeatingPlan(t, ts.URL, ticketID, "990e8400-e29b-41d4-a716-446655440011", "owner-user", http.StatusConflict)
}

// TestAttachSeatingPlan_ShouldReturn403WhenNotOwner verifies that a non-owner
// cannot attach a seating plan.
func TestAttachSeatingPlan_ShouldReturn403WhenNotOwner(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	_, ticketID := createTicket(t, ts.URL, "Seated Concert", "99.99", "owner-user")
	attachSeatingPlan(t, ts.URL, ticketID, "aa0e8400-e29b-41d4-a716-446655440012", "attacker-user", http.StatusForbidden)
}

// TestDetachSeatingPlan_ShouldReturn403WhenNotOwner verifies that a non-owner
// cannot detach the seating plan.
func TestDetachSeatingPlan_ShouldReturn403WhenNotOwner(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	_, ticketID := createTicket(t, ts.URL, "Seated Concert", "99.99", "owner-user")
	attachSeatingPlan(t, ts.URL, ticketID, "bb0e8400-e29b-41d4-a716-446655440013", "owner-user", http.StatusOK)

	delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/tickets/"+ticketID+"/seating-plan", nil)
	delReq.Header.Set("X-User-Id", "attacker-user")
	delResp, err := http.DefaultClient.Do(delReq)
	require.NoError(t, err)
	defer delResp.Body.Close() //nolint:errcheck
	assert.Equal(t, http.StatusForbidden, delResp.StatusCode)
}

// TestAttachSeatingPlan_ShouldReturn400WhenPlanIdInvalid verifies that a
// non-UUID seatingPlanId is rejected with 400.
func TestAttachSeatingPlan_ShouldReturn400WhenPlanIdInvalid(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	_, ticketID := createTicket(t, ts.URL, "Seated Concert", "99.99", "owner-user")

	body := jsonBody(t, map[string]interface{}{"seatingPlanId": "not-a-uuid"})
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/tickets/"+ticketID+"/seating-plan", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "owner-user")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close() //nolint:errcheck
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

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
		ID:     "seated-ticket-1",
		Title:  "Seated Concert",
		Price:  "150",
		UserID: "organiser-1",
		Quota:  100,
	})
	require.NoError(t, err)
	// Attach via repository directly — bypasses ownership check by calling the
	// mongo implementation which checks ownership; we use the owner's ID.
	err = repo.AttachSeatingPlan(ctx, "seated-ticket-1", "plan-uuid-seated", "organiser-1", "SEATED_MANUAL")
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

// createTicket POSTs a new ticket and returns (statusCode, ticketID).
func createTicket(t *testing.T, baseURL, title, price, userID string) (int, string) {
	t.Helper()
	body := jsonBody(t, map[string]interface{}{"title": title, "price": price})
	req, _ := http.NewRequest(http.MethodPost, baseURL+"/api/tickets", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", userID)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusCreated {
		return resp.StatusCode, ""
	}
	var result map[string]interface{}
	require.NoError(t, decodeJSON(resp, &result))
	return resp.StatusCode, result["id"].(string)
}

// attachSeatingPlan sends PUT /:id/seating-plan and asserts the expected status code.
func attachSeatingPlan(t *testing.T, baseURL, ticketID, planID, userID string, wantStatus int) {
	t.Helper()
	body := jsonBody(t, map[string]interface{}{"seatingPlanId": planID})
	req, _ := http.NewRequest(http.MethodPut, baseURL+"/api/tickets/"+ticketID+"/seating-plan", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", userID)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close() //nolint:errcheck
	assert.Equal(t, wantStatus, resp.StatusCode)
}

// decodeJSON decodes the response body as JSON into dst.
func decodeJSON(resp *http.Response, dst interface{}) error {
	return json.NewDecoder(resp.Body).Decode(dst)
}
