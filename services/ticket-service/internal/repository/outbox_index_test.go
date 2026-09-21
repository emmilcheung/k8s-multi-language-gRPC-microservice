package repository

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The outbox relay polls ClaimPendingOutboxEvents continuously. Without an index
// on outbox.nextAttemptAt that query is a COLLSCAN of the entire tickets
// collection, so relay cost grows with how many tickets have ever been sold
// rather than with how many events are waiting to be published. This test pins
// the property that actually matters: the planner must pick an index, and the
// number of documents examined must track the backlog, not the collection size.
//
// Requires a reachable MongoDB via TEST_MONGO_URI; skipped when unset.
func TestClaimPendingOutboxEvents_ShouldUseIndex_NotCollectionScan(t *testing.T) {
	uri := os.Getenv("TEST_MONGO_URI")
	if uri == "" {
		t.Skip("TEST_MONGO_URI not set; skipping MongoDB index integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	require.NoError(t, client.Ping(ctx, nil))

	dbName := fmt.Sprintf("ticket_outbox_idx_test_%d", time.Now().UnixNano())
	db := client.Database(dbName)
	t.Cleanup(func() { _ = db.Drop(context.Background()) })
	coll := db.Collection("tickets")

	// Build the indexes exactly as the service does at startup.
	require.NoError(t, ensureIndexes(ctx, coll))

	// A collection dominated by drained tickets: 5 000 documents whose outbox
	// array has already been $pull-ed empty, and 3 still holding a pending event.
	const (
		drained = 5000
		pending = 3
	)
	now := time.Now().UTC()
	docs := make([]any, 0, drained+pending)
	for i := 0; i < drained; i++ {
		docs = append(docs, bson.M{
			"_id":    fmt.Sprintf("drained-%05d", i),
			"userId": "u1",
			"title":  "drained ticket",
		})
	}
	for i := 0; i < pending; i++ {
		docs = append(docs, bson.M{
			"_id":    fmt.Sprintf("pending-%05d", i),
			"userId": "u1",
			"title":  "ticket with a pending event",
			"outbox": bson.A{bson.M{
				"id":            fmt.Sprintf("evt-%d", i),
				"type":          string(OutboxEventTypeTicketCreated),
				"nextAttemptAt": now.Add(-time.Minute),
				"attempts":      0,
			}},
		})
	}
	_, err = coll.InsertMany(ctx, docs)
	require.NoError(t, err)

	// The filter below is the one ClaimPendingOutboxEvents issues.
	filter := bson.M{
		"outbox": bson.M{"$elemMatch": bson.M{
			"nextAttemptAt": bson.M{"$lte": now},
			"$or": bson.A{
				bson.M{"claimToken": bson.M{"$exists": false}},
				bson.M{"leaseUntil": bson.M{"$lt": now}},
			},
		}},
	}
	explainCmd := bson.D{
		{Key: "explain", Value: bson.D{
			{Key: "findAndModify", Value: coll.Name()},
			{Key: "query", Value: filter},
			{Key: "update", Value: bson.M{"$set": bson.M{
				"outbox.$.claimToken": "probe",
				"outbox.$.leaseUntil": now.Add(30 * time.Second),
			}}},
			{Key: "new", Value: true},
		}},
		{Key: "verbosity", Value: "executionStats"},
	}

	var explained bson.M
	require.NoError(t, db.RunCommand(ctx, explainCmd).Decode(&explained))

	stages := planStages(explained["queryPlanner"])
	assert.Contains(t, stages, "IXSCAN",
		"claim query must be served by an index; got plan stages %v", stages)
	assert.NotContains(t, stages, "COLLSCAN",
		"claim query must not scan the whole tickets collection; got plan stages %v", stages)

	docsExamined := statInt(t, explained, "totalDocsExamined")
	assert.LessOrEqual(t, docsExamined, int64(pending),
		"documents examined (%d) must track backlog depth (%d), not collection size (%d)",
		docsExamined, pending, drained+pending)
}

// planStages collects the stage names of the winning plan, outermost first.
func planStages(queryPlanner any) []string {
	qp, ok := toM(queryPlanner)
	if !ok {
		return nil
	}
	node, ok := toM(qp["winningPlan"])
	if !ok {
		return nil
	}
	var stages []string
	for {
		if s, ok := node["stage"].(string); ok {
			stages = append(stages, s)
		}
		next, ok := toM(node["inputStage"])
		if !ok {
			return stages
		}
		node = next
	}
}

// toM normalises a decoded BSON sub-document, which the driver may hand back as
// either bson.M or bson.D depending on nesting depth.
func toM(v any) (bson.M, bool) {
	switch t := v.(type) {
	case bson.M:
		return t, true
	case bson.D:
		m := make(bson.M, len(t))
		for _, e := range t {
			m[e.Key] = e.Value
		}
		return m, true
	default:
		return nil, false
	}
}

func statInt(t *testing.T, explained bson.M, key string) int64 {
	t.Helper()
	stats, ok := toM(explained["executionStats"])
	require.True(t, ok, "explain output has no executionStats")
	switch v := stats[key].(type) {
	case int32:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	default:
		t.Fatalf("unexpected type %T for executionStats.%s", stats[key], key)
		return 0
	}
}
