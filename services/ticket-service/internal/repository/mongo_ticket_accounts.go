package repository

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var withoutAccount = bson.M{"accountId": bson.M{"$exists": false}}

// PendingOwners returns up to limit distinct creators who still have tickets
// without an owning account.
func (r *MongoTicketRepository) PendingOwners(ctx context.Context, limit int) ([]string, error) {
	cur, err := r.collection.Aggregate(ctx, bson.A{
		bson.M{"$match": withoutAccount},
		bson.M{"$group": bson.M{"_id": "$userId"}},
		bson.M{"$sort": bson.M{"_id": 1}},
		bson.M{"$limit": limit},
	}, options.Aggregate().SetAllowDiskUse(true))
	if err != nil {
		return nil, fmt.Errorf("pending owners: %w", err)
	}
	var rows []struct {
		ID string `bson:"_id"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("pending owners: %w", err)
	}
	owners := make([]string, 0, len(rows))
	for _, row := range rows {
		owners = append(owners, row.ID)
	}
	return owners, nil
}

// CountPending returns how many tickets lack an owning account and how many
// distinct creators they have.
func (r *MongoTicketRepository) CountPending(ctx context.Context) (tickets, owners int, err error) {
	n, err := r.collection.CountDocuments(ctx, withoutAccount)
	if err != nil {
		return 0, 0, fmt.Errorf("count pending tickets: %w", err)
	}
	cur, err := r.collection.Aggregate(ctx, bson.A{
		bson.M{"$match": withoutAccount},
		bson.M{"$group": bson.M{"_id": "$userId"}},
		bson.M{"$count": "owners"},
	}, options.Aggregate().SetAllowDiskUse(true))
	if err != nil {
		return 0, 0, fmt.Errorf("count pending owners: %w", err)
	}
	var rows []struct {
		Owners int `bson:"owners"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return 0, 0, fmt.Errorf("count pending owners: %w", err)
	}
	if len(rows) > 0 {
		owners = rows[0].Owners
	}
	return int(n), owners, nil
}

// SetAccountForOwner records the owning account on every ticket the user
// created that has none yet. It does not bump version or updatedAt: giving a
// ticket an owner is not an edit, and it must not make a concurrent organizer
// edit fail with a version conflict.
func (r *MongoTicketRepository) SetAccountForOwner(ctx context.Context, userID, accountID string) (int64, error) {
	res, err := r.collection.UpdateMany(ctx,
		bson.M{"userId": userID, "accountId": bson.M{"$exists": false}},
		bson.M{"$set": bson.M{"accountId": accountID}})
	if err != nil {
		return 0, fmt.Errorf("set account for owner: %w", err)
	}
	return res.ModifiedCount, nil
}
