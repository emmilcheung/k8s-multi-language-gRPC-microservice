package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/kafka"
	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// credRepoDouble is a controllable stub for CredentialRepository.
type credRepoDouble struct {
	// byIssuanceKey maps issuance_key → credential (simulates the DB unique index).
	byIssuanceKey map[string]*repository.AdmissionCredential
	created       []*repository.AdmissionCredential
	findErr       error
	createErr     error
}

func newCredRepoDouble() *credRepoDouble {
	return &credRepoDouble{byIssuanceKey: make(map[string]*repository.AdmissionCredential)}
}

func (r *credRepoDouble) FindByIssuanceKey(_ context.Context, key string) (*repository.AdmissionCredential, error) {
	if r.findErr != nil {
		return nil, r.findErr
	}
	if c, ok := r.byIssuanceKey[key]; ok {
		return c, nil
	}
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) Create(_ context.Context, cred *repository.AdmissionCredential) error {
	if r.createErr != nil {
		return r.createErr
	}
	r.byIssuanceKey[cred.IssuanceKey] = cred
	r.created = append(r.created, cred)
	return nil
}

func (r *credRepoDouble) FindByID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}
func (r *credRepoDouble) FindByTicketID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}
func (r *credRepoDouble) FindByTicketAndOrder(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}
func (r *credRepoDouble) UpdateStatus(_ context.Context, _ string, _ repository.CredentialStatus) error {
	return nil
}

// pubDouble records Publish calls.
type pubDouble struct {
	published []publishedMsg
	err       error
}

type publishedMsg struct {
	topic string
	key   []byte
	value []byte
}

func (p *pubDouble) Publish(topic string, key, value []byte) error {
	p.published = append(p.published, publishedMsg{topic: topic, key: key, value: value})
	return p.err
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newTestIssuanceService(t *testing.T, repo *credRepoDouble, pub *pubDouble) *IssuanceService {
	t.Helper()
	const signingKey = "test-signing-key-that-is-at-least-32-characters"
	gen := qr.NewGenerator(signingKey)
	return NewIssuanceService(repo, pub, gen, time.Hour, zap.NewNop())
}

func completedEvent(orderID, ticketID string, qty int, seatIDs ...string) kafka.OrderCompletedData {
	return kafka.OrderCompletedData{
		OrderID:  orderID,
		UserID:   "user-1", // UserID must NOT appear in tokens/events
		TicketID: ticketID,
		Quantity: qty,
		SeatIDs:  seatIDs,
	}
}

// ---------------------------------------------------------------------------
// Tests: GA (general-admission) orders
// ---------------------------------------------------------------------------

func TestOnOrderCompleted_GA_SingleUnit_IssuesOneCredential(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-1", "ticket-1", 1))
	require.NoError(t, err)

	assert.Len(t, repo.created, 1, "one credential expected for qty=1")
	cred := repo.created[0]
	assert.Equal(t, "order-1:unit:0", cred.IssuanceKey)
	assert.Equal(t, "ticket-1", cred.TicketID)
	assert.Equal(t, "order-1", cred.OrderID)
	// eventId derivation: ticketId is used as eventId (see WS2 decision)
	assert.Equal(t, "ticket-1", cred.EventID)
	assert.Equal(t, repository.CredentialStatusIssued, cred.Status)
	assert.NotEmpty(t, cred.ID, "credential ID must be non-empty UUID")
	assert.NotEmpty(t, cred.TokenID, "token ID must be non-empty UUID")
	assert.NotEqual(t, cred.ID, cred.TokenID, "credential ID and token ID must differ")
}

func TestOnOrderCompleted_GA_MultiQuantity_IssuesOneCredentialPerUnit(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-multi", "ticket-1", 3))
	require.NoError(t, err)

	require.Len(t, repo.created, 3, "three credentials expected for qty=3")
	expectedKeys := []string{"order-multi:unit:0", "order-multi:unit:1", "order-multi:unit:2"}
	for i, cred := range repo.created {
		assert.Equal(t, expectedKeys[i], cred.IssuanceKey)
		assert.Equal(t, "ticket-1", cred.TicketID)
		assert.Equal(t, "order-multi", cred.OrderID)
	}
	// Each credential must have a unique ID and token_id.
	ids := make(map[string]bool)
	tokenIDs := make(map[string]bool)
	for _, c := range repo.created {
		assert.False(t, ids[c.ID], "credential IDs must be unique")
		assert.False(t, tokenIDs[c.TokenID], "token IDs must be unique")
		ids[c.ID] = true
		tokenIDs[c.TokenID] = true
	}
}

// ---------------------------------------------------------------------------
// Tests: seated orders
// ---------------------------------------------------------------------------

func TestOnOrderCompleted_Seated_IssuesOneCredentialPerSeat(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(),
		completedEvent("order-seated", "ticket-2", 0, "seat-A1", "seat-A2", "seat-A3"),
	)
	require.NoError(t, err)

	require.Len(t, repo.created, 3, "three credentials expected for 3 seats")
	expectedKeys := []string{
		"order-seated:seat:seat-A1",
		"order-seated:seat:seat-A2",
		"order-seated:seat:seat-A3",
	}
	for i, cred := range repo.created {
		assert.Equal(t, expectedKeys[i], cred.IssuanceKey)
		assert.Equal(t, "ticket-2", cred.TicketID)
	}
}

// ---------------------------------------------------------------------------
// Tests: idempotency
// ---------------------------------------------------------------------------

func TestOnOrderCompleted_Idempotent_SameEventDeliveredTwice(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	evt := completedEvent("order-idem", "ticket-idem", 2)

	// First delivery.
	require.NoError(t, svc.OnOrderCompleted(context.Background(), evt))
	assert.Len(t, repo.created, 2)

	// Second delivery of identical event.
	require.NoError(t, svc.OnOrderCompleted(context.Background(), evt))
	// No new credentials must be created.
	assert.Len(t, repo.created, 2, "duplicate delivery must not create additional credentials")
	// Events published: 2 on first delivery, 0 on second (already-existing path).
	assert.Len(t, pub.published, 2, "events must only be published on first issuance")
}

func TestOnOrderCompleted_Idempotent_SeatedEventDeliveredTwice(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	evt := completedEvent("order-seated-idem", "ticket-s", 0, "seat-B1", "seat-B2")

	require.NoError(t, svc.OnOrderCompleted(context.Background(), evt))
	assert.Len(t, repo.created, 2)

	require.NoError(t, svc.OnOrderCompleted(context.Background(), evt))
	assert.Len(t, repo.created, 2, "duplicate delivery must not create additional credentials")
}

// ---------------------------------------------------------------------------
// Tests: event publishing
// ---------------------------------------------------------------------------

func TestOnOrderCompleted_PublishesQRIssuedEvent(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-pub", "ticket-pub", 1))
	require.NoError(t, err)

	require.Len(t, pub.published, 1, "one event expected")
	msg := pub.published[0]
	assert.Equal(t, kafka.TopicAttendanceQRIssued, msg.topic)
	// Partition key must be the credentialId.
	credID := repo.created[0].ID
	assert.Equal(t, []byte(credID), msg.key)
}

func TestOnOrderCompleted_PublishFailure_DoesNotRollbackCredential(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{err: errors.New("kafka broker unavailable")}
	svc := newTestIssuanceService(t, repo, pub)

	// Even though publish fails, the handler must succeed (credential is persisted).
	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-pub-fail", "ticket-pf", 1))
	require.NoError(t, err, "publish failure must not fail the handler (credential persisted)")
	assert.Len(t, repo.created, 1, "credential must be stored despite publish failure")
}

// ---------------------------------------------------------------------------
// Tests: QR token payload
// ---------------------------------------------------------------------------

func TestOnOrderCompleted_TokenContainsExpectedClaims(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	const signingKey = "test-signing-key-that-is-at-least-32-characters"
	gen := qr.NewGenerator(signingKey)
	svc := NewIssuanceService(repo, pub, gen, time.Hour, zap.NewNop())

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-tok", "ticket-tok", 1))
	require.NoError(t, err)

	// Extract QR token from published event payload.
	require.Len(t, pub.published, 1)
	var envelope kafka.CloudEvent
	require.NoError(t, unmarshalCloudEvent(pub.published[0].value, &envelope))
	var data QRIssuedEventData
	require.NoError(t, unmarshalBytes([]byte(envelope.Data), &data))

	assert.NotEmpty(t, data.QRToken, "qrToken must be present in issuance event")

	// Verify and decode the token.
	claims, err := gen.Verify(data.QRToken)
	require.NoError(t, err, "issued token must be verifiable")
	assert.Equal(t, 1, claims.V, "token format version must be 1")
	assert.Equal(t, repo.created[0].ID, claims.CredentialID, "credentialId must match stored credential")
	assert.Equal(t, "ticket-tok", claims.TicketID)
	assert.Equal(t, "ticket-tok", claims.EventID, "eventId must equal ticketId (WS2 derivation)")
	assert.Equal(t, 1, claims.TokenVersion)
	assert.False(t, claims.ExpiresAt.IsZero(), "expiry must be set")
	assert.True(t, claims.ExpiresAt.After(time.Now()), "expiry must be in the future")
}

func TestOnOrderCompleted_TokenContainsNoPII(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	const signingKey = "test-signing-key-that-is-at-least-32-characters"
	gen := qr.NewGenerator(signingKey)
	svc := NewIssuanceService(repo, pub, gen, time.Hour, zap.NewNop())

	const userID = "user-pii-test"
	evt := kafka.OrderCompletedData{
		OrderID:  "order-pii",
		UserID:   userID,
		TicketID: "ticket-pii",
		Quantity: 1,
	}
	require.NoError(t, svc.OnOrderCompleted(context.Background(), evt))

	// The published event must not contain the userID.
	require.Len(t, pub.published, 1)
	msg := string(pub.published[0].value)
	assert.NotContains(t, msg, userID, "published event must not contain PII (userId)")
}

// ---------------------------------------------------------------------------
// Tests: input validation
// ---------------------------------------------------------------------------

func TestOnOrderCompleted_MissingOrderID_ReturnsError(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(), kafka.OrderCompletedData{
		TicketID: "ticket-1",
		Quantity: 1,
	})
	require.Error(t, err)
	assert.Empty(t, repo.created, "no credentials should be created for invalid input")
}

func TestOnOrderCompleted_MissingTicketID_ReturnsError(t *testing.T) {
	repo := newCredRepoDouble()
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(), kafka.OrderCompletedData{
		OrderID:  "order-1",
		Quantity: 1,
	})
	require.Error(t, err)
	assert.Empty(t, repo.created)
}

func TestOnOrderCompleted_RepositoryFindError_PropagatesError(t *testing.T) {
	repo := newCredRepoDouble()
	repo.findErr = errors.New("db connection lost")
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-err", "ticket-err", 1))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "db connection lost")
	assert.Empty(t, repo.created)
}

func TestOnOrderCompleted_RepositoryCreateError_PropagatesError(t *testing.T) {
	repo := newCredRepoDouble()
	repo.createErr = errors.New("unique violation")
	pub := &pubDouble{}
	svc := newTestIssuanceService(t, repo, pub)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-creat-err", "ticket-ce", 1))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unique violation")
}

// ---------------------------------------------------------------------------
// Tests: admissionUnits derivation
// ---------------------------------------------------------------------------

func TestAdmissionUnits_GAOrder_QuantityZero_YieldsOneUnit(t *testing.T) {
	data := kafka.OrderCompletedData{OrderID: "o1", TicketID: "t1", Quantity: 0}
	units := admissionUnits(data)
	require.Len(t, units, 1)
	assert.Equal(t, "o1:unit:0", units[0].issuanceKey)
}

func TestAdmissionUnits_GAOrder_QuantityThree_YieldsThreeUnits(t *testing.T) {
	data := kafka.OrderCompletedData{OrderID: "o2", TicketID: "t1", Quantity: 3}
	units := admissionUnits(data)
	require.Len(t, units, 3)
	assert.Equal(t, "o2:unit:0", units[0].issuanceKey)
	assert.Equal(t, "o2:unit:1", units[1].issuanceKey)
	assert.Equal(t, "o2:unit:2", units[2].issuanceKey)
}

func TestAdmissionUnits_SeatedOrder_YieldsOneUnitPerSeat(t *testing.T) {
	data := kafka.OrderCompletedData{
		OrderID:  "o3",
		TicketID: "t1",
		Quantity: 2, // quantity is ignored when seatIds are present
		SeatIDs:  []string{"s1", "s2"},
	}
	units := admissionUnits(data)
	require.Len(t, units, 2)
	assert.Equal(t, "o3:seat:s1", units[0].issuanceKey)
	assert.Equal(t, "o3:seat:s2", units[1].issuanceKey)
}

// ---------------------------------------------------------------------------
// Helpers for unmarshalling test payloads
// ---------------------------------------------------------------------------

func unmarshalCloudEvent(data []byte, out *kafka.CloudEvent) error {
	return json.Unmarshal(data, out)
}

func unmarshalBytes(data []byte, out interface{}) error {
	return json.Unmarshal(data, out)
}
