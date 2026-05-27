package repository

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// SavedEvent represents a user's saved event (ticket detail).
// In v1, eventId maps to the existing ticketId.
type SavedEvent struct {
	UserID    string    `bson:"userId"`
	EventID   string    `bson:"eventId"` // maps to ticketId in v1
	SavedAt   time.Time `bson:"savedAt"`
	UpdatedAt time.Time `bson:"updatedAt"`
}

// SavedEventRepository defines the storage interface for user saved events.
type SavedEventRepository interface {
	SaveEvent(ctx context.Context, userID, eventID string) error
	UnsaveEvent(ctx context.Context, userID, eventID string) error
	IsSaved(ctx context.Context, userID, eventID string) (bool, error)
}

// MongoSavedEventRepository implements SavedEventRepository against MongoDB.
type MongoSavedEventRepository struct {
	collection *mongo.Collection
}

// NewMongoSavedEventRepository creates a new saved-event repository.
// It reuses the existing MongoDB client and database, creating the saved_events collection.
func NewMongoSavedEventRepository(client *mongo.Client, dbName string) (*MongoSavedEventRepository, error) {
	db := client.Database(dbName)
	coll := db.Collection("saved_events")

	// Ensure compound unique index on (userId, eventId)
	indexModel := mongo.IndexModel{
		Keys: bson.D{
			{Key: "userId", Value: 1},
			{Key: "eventId", Value: 1},
		},
		Options: options.Index().SetUnique(true),
	}
	if _, err := coll.Indexes().CreateOne(context.Background(), indexModel); err != nil {
		return nil, fmt.Errorf("create saved_events index: %w", err)
	}

	// Create index on userId for efficient user-specific queries
	userIndexModel := mongo.IndexModel{
		Keys:    bson.D{{Key: "userId", Value: 1}},
		Options: options.Index(),
	}
	if _, err := coll.Indexes().CreateOne(context.Background(), userIndexModel); err != nil {
		return nil, fmt.Errorf("create saved_events userId index: %w", err)
	}

	return &MongoSavedEventRepository{collection: coll}, nil
}

// SaveEvent saves an event for a user. Idempotent: if already saved, updates the timestamp.
func (r *MongoSavedEventRepository) SaveEvent(ctx context.Context, userID, eventID string) error {
	now := time.Now().UTC()
	filter := bson.M{"userId": userID, "eventId": eventID}
	update := bson.M{
		"$set": bson.M{"updatedAt": now},
		"$setOnInsert": bson.M{
			"userId":  userID,
			"eventId": eventID,
			"savedAt": now,
		},
	}
	opts := options.UpdateOne().SetUpsert(true)
	if _, err := r.collection.UpdateOne(ctx, filter, update, opts); err != nil {
		return fmt.Errorf("mongo save event: %w", err)
	}
	return nil
}

// UnsaveEvent removes a saved event for a user. Idempotent: no error if not saved.
func (r *MongoSavedEventRepository) UnsaveEvent(ctx context.Context, userID, eventID string) error {
	filter := bson.M{"userId": userID, "eventId": eventID}
	if _, err := r.collection.DeleteOne(ctx, filter); err != nil {
		return fmt.Errorf("mongo unsave event: %w", err)
	}
	return nil
}

// IsSaved checks if a user has saved a specific event.
func (r *MongoSavedEventRepository) IsSaved(ctx context.Context, userID, eventID string) (bool, error) {
	filter := bson.M{"userId": userID, "eventId": eventID}
	count, err := r.collection.CountDocuments(ctx, filter)
	if err != nil {
		return false, fmt.Errorf("mongo check saved: %w", err)
	}
	return count > 0, nil
}
