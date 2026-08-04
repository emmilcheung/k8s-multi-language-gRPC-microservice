package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/kafka"
	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/jackc/pgx/v5"
	pgxpgconn "github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

type credRepoDouble struct {
	byIssuanceKey      map[string]*repository.AdmissionCredential
	created            []*repository.AdmissionCredential
	outboxByID         map[string]*repository.OutboxRow
	outboxCreated      []*repository.OutboxRow
	findErr            error
	createErr          error
	createConflictCred *repository.AdmissionCredential
	listUnpublishedErr error
	markPublishedErr   error
	deletePublishedErr error
}

func newCredRepoDouble() *credRepoDouble {
	return &credRepoDouble{
		byIssuanceKey: make(map[string]*repository.AdmissionCredential),
		outboxByID:    make(map[string]*repository.OutboxRow),
	}
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

func (r *credRepoDouble) CreateWithOutbox(_ context.Context, cred *repository.AdmissionCredential, outbox *repository.OutboxRow) error {
	if r.createErr != nil {
		if r.createConflictCred != nil {
			r.byIssuanceKey[r.createConflictCred.IssuanceKey] = r.createConflictCred
		}
		return r.createErr
	}
	r.byIssuanceKey[cred.IssuanceKey] = cred
	r.created = append(r.created, cred)
	r.outboxByID[outbox.ID] = outbox
	r.outboxCreated = append(r.outboxCreated, outbox)
	return nil
}

func (r *credRepoDouble) ListUnpublished(_ context.Context, limit int) ([]*repository.OutboxRow, error) {
	if r.listUnpublishedErr != nil {
		return nil, r.listUnpublishedErr
	}
	rows := make([]*repository.OutboxRow, 0, len(r.outboxByID))
	for _, row := range r.outboxByID {
		if !row.Published {
			rows = append(rows, row)
		}
	}
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	return rows, nil
}

func (r *credRepoDouble) MarkPublished(_ context.Context, id string, publishedAt time.Time) error {
	if r.markPublishedErr != nil {
		return r.markPublishedErr
	}
	row, ok := r.outboxByID[id]
	if !ok {
		return repository.ErrNotFound
	}
	row.Published = true
	for _, cred := range r.byIssuanceKey {
		if cred.ID == id {
			ts := publishedAt
			cred.IssuanceEventPublishedAt = &ts
			return nil
		}
	}
	return repository.ErrNotFound
}

// ListUnpublishedTx satisfies repository.OutboxRepository; the test double
// ignores tx and delegates to the in-memory store.
func (r *credRepoDouble) ListUnpublishedTx(_ context.Context, _ pgx.Tx, limit int) ([]*repository.OutboxRow, error) {
	return r.ListUnpublished(context.Background(), limit)
}

// MarkPublishedTx satisfies repository.OutboxRepository; the test double
// ignores tx and delegates to the in-memory store.
func (r *credRepoDouble) MarkPublishedTx(_ context.Context, _ pgx.Tx, id string, publishedAt time.Time) error {
	return r.MarkPublished(context.Background(), id, publishedAt)
}

// DeletePublishedBefore satisfies repository.OutboxRepository, mirroring the
// bounded delete the Postgres implementation issues.
func (r *credRepoDouble) DeletePublishedBefore(_ context.Context, before time.Time, limit int) (int64, error) {
	if r.deletePublishedErr != nil {
		return 0, r.deletePublishedErr
	}
	var deleted int64
	for id, row := range r.outboxByID {
		if deleted >= int64(limit) {
			break
		}
		if row.Published && row.CreatedAt.Before(before) {
			delete(r.outboxByID, id)
			deleted++
		}
	}
	return deleted, nil
}

func (r *credRepoDouble) FindByID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) FindByTicketID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) FindByTicketAndBuyer(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) FindByTicketAndOrder(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) Create(_ context.Context, _ *repository.AdmissionCredential) error {
	return r.createErr
}

func (r *credRepoDouble) ConsumeIssued(
	_ context.Context,
	_ string,
	_ time.Time,
	_, _ string,
) (*repository.AdmissionCredential, bool, error) {
	return nil, false, repository.ErrNotFound
}

func (r *credRepoDouble) UpdateStatus(_ context.Context, _ string, _ repository.CredentialStatus) error {
	return nil
}

func (r *credRepoDouble) MarkEventPublished(_ context.Context, _ string, _ time.Time) error {
	return nil
}

func (r *credRepoDouble) ListCheckedInByEventID(_ context.Context, _ string, _ int) ([]*repository.AdmissionCredential, error) {
	return []*repository.AdmissionCredential{}, nil
}

func (r *credRepoDouble) CreateTransfer(_ context.Context, _ *repository.AdmissionTransfer) error {
	return nil
}

func (r *credRepoDouble) RecallTransfer(_ context.Context, _, _ string, _ time.Time) (*repository.AdmissionTransfer, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) AcceptTransfer(_ context.Context, _, _ string, _ time.Time) (*repository.AdmissionTransfer, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) FindTransferByID(_ context.Context, _ string) (*repository.AdmissionTransfer, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) FindLatestTransferByCredentialID(_ context.Context, _ string) (*repository.AdmissionTransfer, error) {
	return nil, repository.ErrNotFound
}

func (r *credRepoDouble) UpdateCredentialBuyer(_ context.Context, _, _ string) error {
	return nil
}

type pubDouble struct {
	published []publishedMsg
	err       error
	// failFromNth makes Publish start failing at the Nth call (1-based), so a
	// partial-batch failure can be exercised. Zero means "use err for all calls".
	failFromNth int
}

type publishedMsg struct {
	topic string
	key   []byte
	value []byte
}

func (p *pubDouble) Publish(topic string, key, value []byte) error {
	p.published = append(p.published, publishedMsg{topic: topic, key: key, value: value})
	if p.failFromNth > 0 && len(p.published) < p.failFromNth {
		return nil
	}
	return p.err
}

// noopTxBeginner satisfies TxBeginner for unit tests.  It returns a noopTx
// whose Commit/Rollback are no-ops; credRepoDouble ignores the tx argument so
// the unit tests exercise publish + mark-published logic without a real DB.
type noopTxBeginner struct{}

func (noopTxBeginner) Begin(_ context.Context) (pgx.Tx, error) { return noopTx{}, nil }

// noopTx is a pgx.Tx stub where every method is a no-op.
type noopTx struct{}

func (noopTx) Begin(_ context.Context) (pgx.Tx, error)           { return noopTx{}, nil }
func (noopTx) Commit(_ context.Context) error                     { return nil }
func (noopTx) Rollback(_ context.Context) error                   { return nil }
func (noopTx) Exec(_ context.Context, _ string, _ ...any) (pgxpgconn.CommandTag, error) {
	return pgxpgconn.CommandTag{}, nil
}
func (noopTx) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) { return nil, nil }
func (noopTx) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row        { return nil }
func (noopTx) CopyFrom(_ context.Context, _ pgx.Identifier, _ []string, _ pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (noopTx) SendBatch(_ context.Context, _ *pgx.Batch) pgx.BatchResults { return nil }
func (noopTx) LargeObjects() pgx.LargeObjects                             { return pgx.LargeObjects{} }
func (noopTx) Prepare(_ context.Context, _, _ string) (*pgxpgconn.StatementDescription, error) {
	return nil, nil
}
func (noopTx) Conn() *pgx.Conn { return nil }

// recordingTx records whether the relay committed the batch, which is the only
// externally visible difference between "commit the rows already published" and
// "roll the whole batch back" when the repository double ignores the tx.
type recordingTx struct {
	noopTx
	committed bool
}

func (t *recordingTx) Commit(_ context.Context) error { t.committed = true; return nil }

type recordingTxBeginner struct{ tx *recordingTx }

func (b *recordingTxBeginner) Begin(_ context.Context) (pgx.Tx, error) { return b.tx, nil }

func newTestIssuanceService(t *testing.T, repo *credRepoDouble) *IssuanceService {
	t.Helper()
	const signingKey = "test-signing-key-that-is-at-least-32-characters"
	gen := qr.NewGenerator(signingKey)
	return NewIssuanceService(repo, gen, time.Hour, zap.NewNop())
}

func completedEvent(orderID, ticketID string, qty int, seatIDs ...string) kafka.OrderCompletedData {
	return kafka.OrderCompletedData{
		OrderID:  orderID,
		UserID:   "user-1",
		TicketID: ticketID,
		Quantity: qty,
		SeatIDs:  seatIDs,
	}
}

func TestOnOrderCompleted_GA_MultiQuantity_WritesCredentialsAndOutboxRows(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-multi", "ticket-1", 3))
	require.NoError(t, err)

	require.Len(t, repo.created, 3)
	require.Len(t, repo.outboxCreated, 3)
	for i, cred := range repo.created {
		assert.Equal(t, "order-multi:unit:"+string('0'+rune(i)), cred.IssuanceKey)
		assert.Equal(t, cred.ID, repo.outboxCreated[i].ID)
		assert.Equal(t, kafka.TopicAttendanceQRIssued, repo.outboxCreated[i].Topic)
		assert.Equal(t, cred.ID, repo.outboxCreated[i].PartitionKey)
		assert.Nil(t, cred.IssuanceEventPublishedAt)
	}
}

func TestOnOrderCompleted_Seated_MultiSeat_WritesCredentialsAndOutboxRows(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)

	err := svc.OnOrderCompleted(context.Background(),
		completedEvent("order-seated", "ticket-2", 0, "seat-A1", "seat-A2", "seat-A3"),
	)
	require.NoError(t, err)

	require.Len(t, repo.created, 3)
	expectedKeys := []string{
		"order-seated:seat:seat-A1",
		"order-seated:seat:seat-A2",
		"order-seated:seat:seat-A3",
	}
	for i, cred := range repo.created {
		assert.Equal(t, expectedKeys[i], cred.IssuanceKey)
		assert.Equal(t, cred.ID, repo.outboxCreated[i].ID)
	}
}

func TestOnOrderCompleted_DuplicateDelivery_DoesNotCreateDuplicateOutboxRows(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)
	evt := completedEvent("order-idem", "ticket-idem", 2)

	require.NoError(t, svc.OnOrderCompleted(context.Background(), evt))
	require.NoError(t, svc.OnOrderCompleted(context.Background(), evt))

	assert.Len(t, repo.created, 2)
	assert.Len(t, repo.outboxCreated, 2)
}

func TestOnOrderCompleted_ExistingPublishedCredential_DuplicateDelivery_NoOpsSuccessfully(t *testing.T) {
	now := time.Now().UTC()
	repo := newCredRepoDouble()
	repo.byIssuanceKey["order-published:unit:0"] = &repository.AdmissionCredential{
		ID:                       "f16e9b12-0f5f-4f49-828b-3e35c3c2d3f8",
		IssuanceKey:              "order-published:unit:0",
		TicketID:                 "ticket-published",
		OrderID:                  "order-published",
		EventID:                  "ticket-published",
		TokenVersion:             1,
		TokenID:                  "e6d5e5d5-2bc7-4f65-9c3f-1d2a7c0a2b61",
		Status:                   repository.CredentialStatusIssued,
		IssuedAt:                 now,
		IssuanceEventPublishedAt: &now,
	}

	svc := newTestIssuanceService(t, repo)
	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-published", "ticket-published", 1))
	require.NoError(t, err)

	assert.Empty(t, repo.created)
	assert.Empty(t, repo.outboxCreated)
}

func TestOnOrderCompleted_ExistingUnpublishedCredential_LeavesRelayResponsibilityToOutbox(t *testing.T) {
	now := time.Now().UTC()
	repo := newCredRepoDouble()
	repo.byIssuanceKey["order-pending:unit:0"] = &repository.AdmissionCredential{
		ID:           "44582c5c-a5d1-470d-978b-766d294bd492",
		IssuanceKey:  "order-pending:unit:0",
		TicketID:     "ticket-pending",
		OrderID:      "order-pending",
		EventID:      "ticket-pending",
		TokenVersion: 1,
		TokenID:      "c1bf689b-0349-47a9-b2b1-d5d0d930b654",
		Status:       repository.CredentialStatusIssued,
		IssuedAt:     now,
	}
	repo.outboxByID["44582c5c-a5d1-470d-978b-766d294bd492"] = &repository.OutboxRow{
		ID:           "44582c5c-a5d1-470d-978b-766d294bd492",
		Topic:        kafka.TopicAttendanceQRIssued,
		Payload:      []byte(`{"id":"44582c5c-a5d1-470d-978b-766d294bd492"}`),
		PartitionKey: "44582c5c-a5d1-470d-978b-766d294bd492",
	}

	svc := newTestIssuanceService(t, repo)
	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-pending", "ticket-pending", 1))
	require.NoError(t, err)

	assert.Empty(t, repo.created)
	assert.Empty(t, repo.outboxCreated)
}

func TestOnOrderCompleted_CreateConflict_ReReadsAndCollapsesToSuccess(t *testing.T) {
	now := time.Now().UTC()
	repo := newCredRepoDouble()
	repo.createErr = repository.ErrDuplicate
	repo.createConflictCred = &repository.AdmissionCredential{
		ID:           "a9d0db1d-14a4-4e66-9f08-2d2d2b3f6b73",
		IssuanceKey:  "order-race:unit:0",
		TicketID:     "ticket-race",
		OrderID:      "order-race",
		EventID:      "ticket-race",
		TokenVersion: 1,
		TokenID:      "d4b3f8c8-6ef0-4514-9d05-62f0f6f3f6d8",
		Status:       repository.CredentialStatusIssued,
		IssuedAt:     now,
	}

	svc := newTestIssuanceService(t, repo)
	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-race", "ticket-race", 1))
	require.NoError(t, err)
	assert.Empty(t, repo.created)
	assert.Empty(t, repo.outboxCreated)
}

func TestOnOrderCompleted_MissingUserID_ReturnsMalformedError(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)
	evt := completedEvent("order-no-user", "ticket-1", 1)
	evt.UserID = "   "

	err := svc.OnOrderCompleted(context.Background(), evt)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "userId is required")
}

func TestOnOrderCompleted_GA_QuantityZero_NoSeats_ReturnsError(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-invalid", "ticket-invalid", 0))
	require.Error(t, err)
	assert.Empty(t, repo.created)
	assert.Empty(t, repo.outboxCreated)
}

func TestOnOrderCompleted_Seated_BlankSeatID_ReturnsError(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-bad-seat", "ticket-seat", 0, "seat-A1", "   "))
	require.Error(t, err)
	assert.Empty(t, repo.created)
	assert.Empty(t, repo.outboxCreated)
}

func TestOnOrderCompleted_Seated_DuplicateSeatID_ReturnsError(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-dup-seat", "ticket-seat", 0, "seat-A1", "seat-A1"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "duplicate seatIds")
	assert.Empty(t, repo.created)
	assert.Empty(t, repo.outboxCreated)
}

func TestOnOrderCompleted_Seated_WhitespaceVariantDuplicateSeatID_ReturnsError(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-dup-seat-ws", "ticket-seat", 0, "seat-A1", " seat-A1 "))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "duplicate seatIds")
	assert.Empty(t, repo.created)
	assert.Empty(t, repo.outboxCreated)
}

func TestOnOrderCompleted_WritesStableCloudEventToOutbox(t *testing.T) {
	repo := newCredRepoDouble()
	svc := newTestIssuanceService(t, repo)

	err := svc.OnOrderCompleted(context.Background(), completedEvent("order-outbox", "ticket-outbox", 1))
	require.NoError(t, err)
	require.Len(t, repo.created, 1)
	require.Len(t, repo.outboxCreated, 1)

	var envelope kafka.CloudEvent
	require.NoError(t, json.Unmarshal(repo.outboxCreated[0].Payload, &envelope))
	assert.Equal(t, repo.created[0].ID, envelope.ID)
	assert.Equal(t, kafka.TopicAttendanceQRIssued, envelope.Type)

	var data QRIssuedEventData
	require.NoError(t, json.Unmarshal(envelope.Data, &data))
	assert.Equal(t, repo.created[0].ID, data.CredentialID)
	assert.Equal(t, "ticket-outbox", data.TicketID)
	assert.Equal(t, "ticket-outbox", data.EventID)
	assert.Equal(t, "order-outbox", data.OrderID)
	assert.NotEmpty(t, data.QRToken)
	assert.NotContains(t, string(repo.outboxCreated[0].Payload), "user-1")
}

func TestOutboxRelay_RunOnce_PublishesAndMarksPublished(t *testing.T) {
	now := time.Now().UTC()
	repo := newCredRepoDouble()
	repo.byIssuanceKey["order-relay:unit:0"] = &repository.AdmissionCredential{
		ID:           "bb61f2f3-8299-4d9f-b4b8-0532c4ff4bba",
		IssuanceKey:  "order-relay:unit:0",
		TicketID:     "ticket-relay",
		OrderID:      "order-relay",
		EventID:      "ticket-relay",
		TokenVersion: 1,
		TokenID:      "8d4da908-730f-4360-b680-2b1b64fcab59",
		Status:       repository.CredentialStatusIssued,
		IssuedAt:     now,
	}
	repo.outboxByID["bb61f2f3-8299-4d9f-b4b8-0532c4ff4bba"] = mustOutboxRow(t, repo.byIssuanceKey["order-relay:unit:0"])
	pub := &pubDouble{}
	relay := NewOutboxRelay(noopTxBeginner{}, repo, pub, zap.NewNop())

	err := relay.RunOnce(context.Background(), 10)
	require.NoError(t, err)
	require.Len(t, pub.published, 1)
	assert.True(t, repo.outboxByID["bb61f2f3-8299-4d9f-b4b8-0532c4ff4bba"].Published)
	assert.NotNil(t, repo.byIssuanceKey["order-relay:unit:0"].IssuanceEventPublishedAt)
}

func TestOutboxRelay_RunOnce_PublishFailure_LeavesRowUnpublished(t *testing.T) {
	now := time.Now().UTC()
	repo := newCredRepoDouble()
	repo.byIssuanceKey["order-relay-fail:unit:0"] = &repository.AdmissionCredential{
		ID:           "fd9b4127-74b7-4977-904c-0cb654ff0c0a",
		IssuanceKey:  "order-relay-fail:unit:0",
		TicketID:     "ticket-relay-fail",
		OrderID:      "order-relay-fail",
		EventID:      "ticket-relay-fail",
		TokenVersion: 1,
		TokenID:      "bc70f270-fd4d-4b4c-931d-40d58b54e34a",
		Status:       repository.CredentialStatusIssued,
		IssuedAt:     now,
	}
	repo.outboxByID["fd9b4127-74b7-4977-904c-0cb654ff0c0a"] = mustOutboxRow(t, repo.byIssuanceKey["order-relay-fail:unit:0"])
	pub := &pubDouble{err: errors.New("broker unavailable")}
	relay := NewOutboxRelay(noopTxBeginner{}, repo, pub, zap.NewNop())

	err := relay.RunOnce(context.Background(), 10)
	require.Error(t, err)
	assert.False(t, repo.outboxByID["fd9b4127-74b7-4977-904c-0cb654ff0c0a"].Published)
	assert.Nil(t, repo.byIssuanceKey["order-relay-fail:unit:0"].IssuanceEventPublishedAt)
}

// A publish failure part-way through a batch must not throw away the rows that
// already reached the broker. Rolling their marks back would re-send every one
// of them on the next tick, so a single flaky publish at position N costs N-1
// duplicate deliveries. The claim is untouched either way — it is the same
// transaction, still held with FOR UPDATE SKIP LOCKED.
func TestOutboxRelay_RunOnce_PartialPublishFailure_CommitsRowsAlreadyOnTheTopic(t *testing.T) {
	now := time.Now().UTC()
	repo := newCredRepoDouble()
	for i, id := range []string{
		"5c1f6d8e-7a1c-4a5d-9a5e-2f0e5f0f9a11",
		"0a2b4c6d-8e0f-4a1b-9c3d-5e7f9a1b3c5d",
	} {
		key := fmt.Sprintf("order-relay-partial:unit:%d", i)
		repo.byIssuanceKey[key] = &repository.AdmissionCredential{
			ID:           id,
			IssuanceKey:  key,
			TicketID:     "ticket-relay-partial",
			OrderID:      "order-relay-partial",
			EventID:      "ticket-relay-partial",
			TokenVersion: 1,
			TokenID:      "b1a4d1a0-6c58-4a7f-9c2e-7d3f5a9b1c60",
			Status:       repository.CredentialStatusIssued,
			IssuedAt:     now,
		}
		repo.outboxByID[id] = mustOutboxRow(t, repo.byIssuanceKey[key])
	}
	pub := &pubDouble{failFromNth: 2, err: errors.New("broker unavailable")}
	tx := &recordingTx{}
	relay := NewOutboxRelay(&recordingTxBeginner{tx: tx}, repo, pub, zap.NewNop())

	err := relay.RunOnce(context.Background(), 10)

	require.Error(t, err, "the caller must still learn that publishing is failing")
	assert.Len(t, pub.published, 2, "the batch must stop at the failing row rather than push on")
	assert.True(t, tx.committed,
		"rows already on the topic must be committed as published; rolling back re-sends them next tick")

	var marked int
	for _, row := range repo.outboxByID {
		if row.Published {
			marked++
		}
	}
	assert.Equal(t, 1, marked, "exactly the row that was published should be marked; the failing row retries")
}

func TestOutboxRelay_RunOnce_MarkPublishedFailure_RetriesSamePayloadAndID(t *testing.T) {
	now := time.Now().UTC()
	repo := newCredRepoDouble()
	repo.byIssuanceKey["order-relay-retry:unit:0"] = &repository.AdmissionCredential{
		ID:           "8177ecbc-ecf0-4d93-bd48-19065e0ad6aa",
		IssuanceKey:  "order-relay-retry:unit:0",
		TicketID:     "ticket-relay-retry",
		OrderID:      "order-relay-retry",
		EventID:      "ticket-relay-retry",
		TokenVersion: 1,
		TokenID:      "f13b5718-d6f2-4b42-98a7-173fb9794c25",
		Status:       repository.CredentialStatusIssued,
		IssuedAt:     now,
	}
	repo.outboxByID["8177ecbc-ecf0-4d93-bd48-19065e0ad6aa"] = mustOutboxRow(t, repo.byIssuanceKey["order-relay-retry:unit:0"])
	pub := &pubDouble{}
	relay := NewOutboxRelay(noopTxBeginner{}, repo, pub, zap.NewNop())

	repo.markPublishedErr = errors.New("db timeout")
	err := relay.RunOnce(context.Background(), 10)
	require.Error(t, err)
	assert.False(t, repo.outboxByID["8177ecbc-ecf0-4d93-bd48-19065e0ad6aa"].Published)

	repo.markPublishedErr = nil
	err = relay.RunOnce(context.Background(), 10)
	require.NoError(t, err)
	require.Len(t, pub.published, 2)
	assert.Equal(t, pub.published[0].value, pub.published[1].value)
	assert.Equal(t, pub.published[0].key, pub.published[1].key)

	var first kafka.CloudEvent
	var second kafka.CloudEvent
	require.NoError(t, json.Unmarshal(pub.published[0].value, &first))
	require.NoError(t, json.Unmarshal(pub.published[1].value, &second))
	assert.Equal(t, first.ID, second.ID)
	assert.True(t, repo.outboxByID["8177ecbc-ecf0-4d93-bd48-19065e0ad6aa"].Published)
	assert.NotNil(t, repo.byIssuanceKey["order-relay-retry:unit:0"].IssuanceEventPublishedAt)
}

func TestNewIssuanceService_DefaultTTLIs48Hours(t *testing.T) {
	// Pass 0 as tokenTTL to trigger the "use default" branch.
	svc := NewIssuanceService(nil, nil, 0, zap.NewNop())
	got := svc.tokenTTL
	want := 48 * time.Hour
	if got != want {
		t.Fatalf("default tokenTTL = %s, want %s", got, want)
	}
}

func mustOutboxRow(t *testing.T, cred *repository.AdmissionCredential) *repository.OutboxRow {
	t.Helper()
	payload, err := buildIssuanceEventPayload(cred, "token-for-"+cred.ID)
	require.NoError(t, err)
	return &repository.OutboxRow{
		ID:           cred.ID,
		Topic:        kafka.TopicAttendanceQRIssued,
		Payload:      payload,
		PartitionKey: cred.ID,
	}
}
