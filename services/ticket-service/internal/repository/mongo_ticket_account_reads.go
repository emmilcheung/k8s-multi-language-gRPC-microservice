package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/ticket-service/internal/audit"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// AuditRecord is one stored history entry. ID is the outbox event id the entry
// was written under, which also breaks ties between entries made in the same
// millisecond when paging.
type AuditRecord struct {
	ID          string `bson:"_id"`
	audit.Entry `bson:",inline"`
}

// pageLimit clamps a requested page size to the range the other listings use.
func pageLimit(limit int) int64 {
	if limit <= 0 {
		return 21
	}
	if limit > 101 {
		return 101
	}
	return int64(limit)
}

// cursorBefore narrows a newest-first listing to rows strictly after the
// cursor "<unixMilli>:<id>". It returns nil when the cursor is absent or not
// one of ours.
func cursorBefore(timeField, after string) bson.M {
	ms, id, ok := ParseCursor(after)
	if !ok {
		return nil
	}
	at := time.UnixMilli(ms).UTC()
	return bson.M{"$or": bson.A{
		bson.M{timeField: bson.M{"$lt": at}},
		bson.M{timeField: at, "_id": bson.M{"$lt": id}},
	}}
}

// FindByAccount returns the events owned by an organizer account, newest first.
// after is a "<unixMilli>:<id>" cursor from the previous page.
func (r *MongoTicketRepository) FindByAccount(ctx context.Context, accountID string, limit int, after string) ([]*Ticket, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := bson.M{"accountId": accountID}
	if c := cursorBefore("createdAt", after); c != nil {
		filter = bson.M{"$and": bson.A{filter, c}}
	}
	cur, err := r.collection.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).
		SetLimit(pageLimit(limit)))
	if err != nil {
		return nil, fmt.Errorf("find tickets by account: %w", err)
	}
	defer cur.Close(ctx) //nolint:errcheck

	var tickets []*Ticket
	if err := cur.All(ctx, &tickets); err != nil {
		return nil, fmt.Errorf("decode tickets by account: %w", err)
	}
	return tickets, nil
}

// ListAuditByResource returns the history of one resource (for example
// "ticket:<id>"), newest first, using the (resource, at) index.
func (r *MongoTicketRepository) ListAuditByResource(ctx context.Context, resource string, limit int, after string) ([]AuditRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := bson.M{"resource": resource}
	if c := cursorBefore("at", after); c != nil {
		filter = bson.M{"$and": bson.A{filter, c}}
	}
	cur, err := r.auditLog.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "at", Value: -1}, {Key: "_id", Value: -1}}).
		SetLimit(pageLimit(limit)))
	if err != nil {
		return nil, fmt.Errorf("list audit by resource: %w", err)
	}
	defer cur.Close(ctx) //nolint:errcheck

	var rows []AuditRecord
	if err := cur.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("decode audit rows: %w", err)
	}
	return rows, nil
}
