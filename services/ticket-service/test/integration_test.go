package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/acme/ticket-service/internal/handler"
	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	echofx "github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	"go.uber.org/zap"
)

// noopPublisher satisfies service.EventPublisher without requiring a real Kafka broker.
// Kafka delivery is covered separately by the producer unit tests.
type noopPublisher struct{}

func (p *noopPublisher) PublishTicketCreated(_ context.Context, _ kafka.TicketEventData) error {
	return nil
}
func (p *noopPublisher) PublishTicketUpdated(_ context.Context, _ kafka.TicketEventData) error {
	return nil
}

// setupTestServer starts a real MongoDB via Testcontainers, wires the full Echo stack,
// and returns a running httptest.Server plus a cleanup function.
func setupTestServer(t *testing.T) (*httptest.Server, func()) {
	t.Helper()
	ctx := context.Background()

	// Spin up a real MongoDB 7 container
	mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err, "failed to start MongoDB container")

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err, "failed to get MongoDB connection string")

	// Each test gets its own database to avoid state leakage
	db := dbName(t.Name())

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, db)
	require.NoError(t, err, "failed to create mongo repository")

	log := zap.NewNop()
	svc := service.NewTicketService(repo, &noopPublisher{}, log)

	e := echofx.New()
	e.HideBanner = true
	e.HidePort = true

	ticketH := handler.NewTicketHandler(svc, log)
	healthH := handler.NewHealthHandler(repo, log)

	e.GET("/healthz/live", healthH.Live)
	e.GET("/healthz/ready", healthH.Ready)

	g := e.Group("/api/tickets")
	g.POST("", ticketH.Create)
	g.GET("", ticketH.List)
	g.GET("/:id", ticketH.GetByID)
	g.PUT("/:id", ticketH.Update)

	ts := httptest.NewServer(e)

	cleanup := func() {
		ts.Close()
		_ = repo.Close(ctx)
		_ = mongoContainer.Terminate(ctx)
	}
	return ts, cleanup
}

// dbName returns a MongoDB-safe database name for a test.
// MongoDB limits database names to 63 characters; we hash the test name to stay well within that.
func dbName(testName string) string {
	h := sha256.Sum256([]byte(testName))
	return fmt.Sprintf("t_%x", h[:8]) // "t_" + 16 hex chars = 18 chars total
}

// --- Helper ---

func jsonBody(t *testing.T, v interface{}) *bytes.Buffer {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return bytes.NewBuffer(b)
}

// --- Tests ---

func TestCreateTicket_ShouldReturn201WithTicketBody(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	body := jsonBody(t, map[string]interface{}{"title": "Concert Ticket", "price": 29.99})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-123")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusCreated, resp.StatusCode)

	var result map[string]interface{}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
	assert.Equal(t, "Concert Ticket", result["title"])
	assert.Equal(t, 29.99, result["price"])
	assert.Equal(t, "user-123", result["userId"])
	assert.NotEmpty(t, result["id"])
}

func TestCreateTicket_ShouldReturn401WhenNoUserHeader(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	body := jsonBody(t, map[string]interface{}{"title": "Concert", "price": 10.0})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
	req.Header.Set("Content-Type", "application/json")
	// No X-User-Id header

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestCreateTicket_ShouldReturn400WhenTitleIsEmpty(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	body := jsonBody(t, map[string]interface{}{"title": "", "price": 10.0})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestCreateTicket_ShouldReturn400WhenPriceIsNegative(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	body := jsonBody(t, map[string]interface{}{"title": "Ticket", "price": -5.0})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestGetTicketByID_ShouldReturn200ForExistingTicket(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	// Create a ticket first
	body := jsonBody(t, map[string]interface{}{"title": "Rock Concert", "price": 50.0})
	createReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("X-User-Id", "user-1")
	createResp, err := http.DefaultClient.Do(createReq)
	require.NoError(t, err)
	defer createResp.Body.Close()
	require.Equal(t, http.StatusCreated, createResp.StatusCode)

	var created map[string]interface{}
	require.NoError(t, json.NewDecoder(createResp.Body).Decode(&created))
	ticketID := created["id"].(string)

	// Fetch by ID
	getReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/tickets/"+ticketID, nil)
	getResp, err := http.DefaultClient.Do(getReq)
	require.NoError(t, err)
	defer getResp.Body.Close()

	assert.Equal(t, http.StatusOK, getResp.StatusCode)
	var ticket map[string]interface{}
	require.NoError(t, json.NewDecoder(getResp.Body).Decode(&ticket))
	assert.Equal(t, ticketID, ticket["id"])
	assert.Equal(t, "Rock Concert", ticket["title"])
}

func TestGetTicketByID_ShouldReturn404ForNonExistentTicket(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/tickets/non-existent-id", nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestListTickets_ShouldReturnEmptyArrayWhenNoTickets(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/tickets", nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	var result []interface{}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))
	assert.Empty(t, result)
}

func TestListTickets_ShouldReturnAllCreatedTickets(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	titles := []string{"Ticket A", "Ticket B", "Ticket C"}
	for _, title := range titles {
		body := jsonBody(t, map[string]interface{}{"title": title, "price": 10.0})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User-Id", "user-1")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusCreated, resp.StatusCode)
	}

	listReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/tickets", nil)
	listResp, err := http.DefaultClient.Do(listReq)
	require.NoError(t, err)
	defer listResp.Body.Close()

	assert.Equal(t, http.StatusOK, listResp.StatusCode)
	var tickets []interface{}
	require.NoError(t, json.NewDecoder(listResp.Body).Decode(&tickets))
	assert.Len(t, tickets, 3)
}

func TestUpdateTicket_ShouldReturn200WhenOwnerUpdates(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	// Create ticket
	body := jsonBody(t, map[string]interface{}{"title": "Old Title", "price": 10.0})
	createReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("X-User-Id", "owner-user")
	createResp, err := http.DefaultClient.Do(createReq)
	require.NoError(t, err)
	defer createResp.Body.Close()
	require.Equal(t, http.StatusCreated, createResp.StatusCode)

	var created map[string]interface{}
	require.NoError(t, json.NewDecoder(createResp.Body).Decode(&created))
	ticketID := created["id"].(string)

	// Update ticket
	updateBody := jsonBody(t, map[string]interface{}{"title": "New Title", "price": 99.99})
	updateReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/tickets/"+ticketID, updateBody)
	updateReq.Header.Set("Content-Type", "application/json")
	updateReq.Header.Set("X-User-Id", "owner-user")
	updateResp, err := http.DefaultClient.Do(updateReq)
	require.NoError(t, err)
	defer updateResp.Body.Close()

	assert.Equal(t, http.StatusOK, updateResp.StatusCode)
	var updated map[string]interface{}
	require.NoError(t, json.NewDecoder(updateResp.Body).Decode(&updated))
	assert.Equal(t, "New Title", updated["title"])
	assert.Equal(t, 99.99, updated["price"])
}

func TestUpdateTicket_ShouldReturn403WhenNonOwnerUpdates(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	// Create ticket as owner
	body := jsonBody(t, map[string]interface{}{"title": "Title", "price": 10.0})
	createReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/tickets", body)
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("X-User-Id", "owner-user")
	createResp, err := http.DefaultClient.Do(createReq)
	require.NoError(t, err)
	defer createResp.Body.Close()

	var created map[string]interface{}
	require.NoError(t, json.NewDecoder(createResp.Body).Decode(&created))
	ticketID := created["id"].(string)

	// Try to update as different user
	updateBody := jsonBody(t, map[string]interface{}{"title": "Hijacked", "price": 1.0})
	updateReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/tickets/"+ticketID, updateBody)
	updateReq.Header.Set("Content-Type", "application/json")
	updateReq.Header.Set("X-User-Id", "attacker-user")
	updateResp, err := http.DefaultClient.Do(updateReq)
	require.NoError(t, err)
	defer updateResp.Body.Close()

	assert.Equal(t, http.StatusForbidden, updateResp.StatusCode)
}

func TestUpdateTicket_ShouldReturn404ForNonExistentTicket(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	body := jsonBody(t, map[string]interface{}{"title": "Title", "price": 10.0})
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/tickets/non-existent", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-1")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestHealthLive_ShouldReturn200(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	resp, err := http.Get(ts.URL + "/healthz/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestHealthReady_ShouldReturn200WhenMongoIsUp(t *testing.T) {
	ts, cleanup := setupTestServer(t)
	defer cleanup()

	resp, err := http.Get(ts.URL + "/healthz/ready")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}
