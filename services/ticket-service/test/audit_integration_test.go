package integration_test

import (
	"context"
	"errors"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/audit"
	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/outbox"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.uber.org/zap"
)

type auditEnv struct {
	repo  *repository.MongoTicketRepository
	audit *mongo.Collection
	db    *mongo.Database
}

func newAuditEnv(t *testing.T) auditEnv {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	c, err := tcmongo.Run(ctx, "mongo:7", tcmongo.WithReplicaSet("rs0"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	uri, err := c.ConnectionString(ctx)
	require.NoError(t, err)
	u, err := url.Parse(uri)
	require.NoError(t, err)
	q := u.Query()
	q.Del("replicaSet")
	q.Set("directConnection", "true")
	u.RawQuery = q.Encode()

	client, err := mongo.Connect(options.Client().ApplyURI(u.String()))
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Disconnect(ctx) })

	name := dbName(t.Name())
	repo, err := repository.NewMongoTicketRepositoryWithClient(ctx, client, name)
	require.NoError(t, err)
	return auditEnv{repo: repo, audit: client.Database(name).Collection("audit_log"), db: client.Database(name)}
}

type flakyProducer struct {
	calls     atomic.Int32
	failFirst bool
}

func (p *flakyProducer) PublishTicketCreated(context.Context, kafka.TicketEventData) error {
	return p.publish()
}

func (p *flakyProducer) PublishTicketUpdated(context.Context, kafka.TicketEventData) error {
	return p.publish()
}

func (p *flakyProducer) publish() error {
	if p.calls.Add(1) == 1 && p.failFirst {
		return errors.New("kafka unavailable")
	}
	return nil
}

func ticketWithAudit(entry audit.Entry) *repository.Ticket {
	event := repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketCreated, repository.TicketOutboxPayload{})
	event.RecordAudit(entry)
	return &repository.Ticket{ID: "audit-ticket", Title: "Show", Price: "10.00", UserID: "owner-1", PendingOutbox: []repository.TicketOutboxEvent{event}}
}

func sampleAudit() audit.Entry {
	return audit.Entry{
		ActorUserID:    "user-1",
		ActorAccountID: "acct-1",
		Action:         "event.create",
		Resource:       "ticket:audit-ticket",
		After:          map[string]any{"title": "Show"},
		TraceID:        "trace-1",
	}
}

func TestRelay_ShouldWriteEachAuditEntryOnce_WhenTheEventIsReplayed(t *testing.T) {
	env := newAuditEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	require.NoError(t, env.repo.Create(ctx, ticketWithAudit(sampleAudit())))

	// The first publish fails after the audit entry was written, so the relay
	// requeues the event and writes the same entry a second time.
	producer := &flakyProducer{failFirst: true}
	go outbox.NewRelay(env.repo, producer, zap.NewNop()).Start(ctx)

	require.Eventually(t, func() bool {
		ticket, err := env.repo.FindByID(ctx, "audit-ticket")
		return err == nil && len(ticket.Outbox) == 0 && producer.calls.Load() >= 2
	}, 20*time.Second, 100*time.Millisecond, "event should be published on retry and acknowledged")

	n, err := env.audit.CountDocuments(ctx, bson.M{})
	require.NoError(t, err)
	assert.EqualValues(t, 1, n, "a replayed event must not duplicate its audit entry")

	var row bson.M
	require.NoError(t, env.audit.FindOne(ctx, bson.M{}).Decode(&row))
	assert.Equal(t, "user-1", row["actorUserId"])
	assert.Equal(t, "event.create", row["action"])
	assert.Equal(t, "ticket:audit-ticket", row["resource"])
	assert.Equal(t, "trace-1", row["traceId"])
}

func TestAuditLog_ShouldNeverStoreAttendeeNamesOrEmails(t *testing.T) {
	env := newAuditEnv(t)
	ctx := context.Background()

	entry := sampleAudit()
	entry.After = map[string]any{"attendeeName": "Ada", "attendeeEmail": "ada@example.com", "quota": 5}
	require.NoError(t, env.repo.WriteAuditEntry(ctx, "evt-1", entry))

	var row bson.M
	require.NoError(t, env.audit.FindOne(ctx, bson.M{"_id": "evt-1"}).Decode(&row))
	assert.NotContains(t, rawString(row), "Ada")
	assert.NotContains(t, rawString(row), "ada@example.com")
	after, ok := toBsonM(row["after"])
	require.True(t, ok)
	assert.Equal(t, "[redacted]", after["attendeeName"])
	assert.Equal(t, "[redacted]", after["attendeeEmail"])
	assert.EqualValues(t, 5, after["quota"])
}

func TestAuditEntry_ShouldBeStoredWithTheOutboxEventInOneDocument(t *testing.T) {
	env := newAuditEnv(t)
	ctx := context.Background()

	entry := sampleAudit()
	entry.After = map[string]any{"attendeeEmail": "ada@example.com"}
	require.NoError(t, env.repo.Create(ctx, ticketWithAudit(entry)))

	var raw bson.M
	require.NoError(t, env.db.Collection("tickets").FindOne(ctx, bson.M{"_id": "audit-ticket"}).Decode(&raw))
	assert.NotContains(t, rawString(raw), "ada@example.com", "personal data is blanked before it reaches even the outbox")
	assert.Contains(t, rawString(raw), "event.create")
}

func toBsonM(v any) (bson.M, bool) {
	switch t := v.(type) {
	case bson.M:
		return t, true
	case bson.D:
		m := bson.M{}
		for _, e := range t {
			m[e.Key] = e.Value
		}
		return m, true
	}
	return nil, false
}

func rawString(v any) string {
	b, _ := bson.MarshalExtJSON(v, false, false)
	return string(b)
}
