package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Ticket is the domain model stored in MongoDB.
type Ticket struct {
	ID        string    `bson:"_id"`
	Title     string    `bson:"title"`
	Price     float64   `bson:"price"`
	UserID    string    `bson:"userId"`
	OrderID   string    `bson:"orderId,omitempty"` // set when reserved
	Version   int       `bson:"version"`
	CreatedAt time.Time `bson:"createdAt"`
	UpdatedAt time.Time `bson:"updatedAt"`
}

// ErrTicketNotFound is returned when a ticket does not exist.
var ErrTicketNotFound = errors.New("ticket not found")

// ErrTicketReserved is returned when trying to update a reserved ticket.
var ErrTicketReserved = errors.New("ticket is reserved")

// ErrVersionConflict is returned when an OCC version mismatch is detected (ticket exists
// but was concurrently modified — the caller should retry with fresh data).
var ErrVersionConflict = errors.New("version conflict: ticket was modified concurrently")

// PaginationParams controls cursor-based pagination for FindAll.
// After is an opaque cursor — the _id of the last ticket seen on the previous page.
// Limit is the maximum number of tickets to return (capped at 100; 0 means 20).
type PaginationParams struct {
	After string // exclusive lower bound (cursor); empty = start from beginning
	Limit int    // max results per page
}

// TicketRepository defines the storage interface.
type TicketRepository interface {
	Create(ctx context.Context, t *Ticket) error
	FindByID(ctx context.Context, id string) (*Ticket, error)
	// FindAll returns a page of tickets ordered by _id ascending.
	// Pass a zero-value PaginationParams for the first page with defaults.
	FindAll(ctx context.Context, p PaginationParams) ([]*Ticket, error)
	Update(ctx context.Context, t *Ticket) error
	// ReserveTicket sets the orderId on a ticket (idempotent).
	ReserveTicket(ctx context.Context, ticketID, orderID string) error
	// ReleaseTicket clears the orderId on a ticket (idempotent).
	ReleaseTicket(ctx context.Context, ticketID string) error
	Ping(ctx context.Context) error
	Close(ctx context.Context) error
}

// MongoTicketRepository implements TicketRepository against MongoDB.
type MongoTicketRepository struct {
	client     *mongo.Client
	collection *mongo.Collection
}

// NewMongoTicketRepository creates a new repository, verifying connectivity at construction time.
func NewMongoTicketRepository(ctx context.Context, uri, dbName string) (*MongoTicketRepository, error) {
	clientOpts := options.Client().ApplyURI(uri)
	client, err := mongo.Connect(clientOpts)
	if err != nil {
		return nil, fmt.Errorf("mongo connect: %w", err)
	}

	if err := client.Ping(ctx, nil); err != nil {
		return nil, fmt.Errorf("mongo ping: %w", err)
	}

	db := client.Database(dbName)
	coll := db.Collection("tickets")

	// Enforce JSON schema validation on the collection
	if err := ensureCollectionSchema(ctx, db, coll); err != nil {
		return nil, fmt.Errorf("ensure schema: %w", err)
	}

	// Create indexes
	if err := ensureIndexes(ctx, coll); err != nil {
		return nil, fmt.Errorf("ensure indexes: %w", err)
	}

	return &MongoTicketRepository{client: client, collection: coll}, nil
}

func ensureCollectionSchema(ctx context.Context, db *mongo.Database, coll *mongo.Collection) error {
	validator := bson.D{
		{Key: "$jsonSchema", Value: bson.D{
			{Key: "bsonType", Value: "object"},
			{Key: "required", Value: bson.A{"_id", "title", "price", "userId", "version", "createdAt", "updatedAt"}},
			{Key: "properties", Value: bson.D{
				{Key: "_id", Value: bson.D{{Key: "bsonType", Value: "string"}}},
				{Key: "title", Value: bson.D{
					{Key: "bsonType", Value: "string"},
					{Key: "minLength", Value: 1},
					{Key: "maxLength", Value: 200},
				}},
				{Key: "price", Value: bson.D{
					{Key: "bsonType", Value: "double"},
					{Key: "minimum", Value: 0},
				}},
				{Key: "userId", Value: bson.D{{Key: "bsonType", Value: "string"}}},
				{Key: "version", Value: bson.D{{Key: "bsonType", Value: "int"}}},
			}},
		}},
	}

	// Try to create the collection with the schema; ignore "already exists" error.
	createOpts := options.CreateCollection().SetValidator(validator)
	err := db.CreateCollection(ctx, "tickets", createOpts)
	if err != nil {
		// collection already exists — apply the validator via collMod
		cmd := bson.D{
			{Key: "collMod", Value: "tickets"},
			{Key: "validator", Value: validator},
			{Key: "validationLevel", Value: "strict"},
		}
		if modErr := db.RunCommand(ctx, cmd).Err(); modErr != nil {
			return modErr
		}
	}
	return nil
}

func ensureIndexes(ctx context.Context, coll *mongo.Collection) error {
	_, err := coll.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "_id", Value: 1}},
			Options: options.Index().SetName("idx_id_asc"),
		},
		{
			Keys:    bson.D{{Key: "userId", Value: 1}},
			Options: options.Index().SetName("idx_userId"),
		},
		{
			Keys:    bson.D{{Key: "orderId", Value: 1}},
			Options: options.Index().SetName("idx_orderId").SetSparse(true),
		},
	})
	return err
}

// Create inserts a new ticket, generating a UUID if ID is empty.
func (r *MongoTicketRepository) Create(ctx context.Context, t *Ticket) error {
	if t.ID == "" {
		t.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	t.CreatedAt = now
	t.UpdatedAt = now
	t.Version = 1

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err := r.collection.InsertOne(ctx, t)
	if err != nil {
		return fmt.Errorf("insert ticket: %w", err)
	}
	return nil
}

// FindByID retrieves a ticket by its UUID string ID.
func (r *MongoTicketRepository) FindByID(ctx context.Context, id string) (*Ticket, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var t Ticket
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&t)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrTicketNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find ticket by id: %w", err)
	}
	return &t, nil
}

// FindAll returns a page of tickets ordered by _id ascending.
// p.After is the last _id seen (exclusive cursor); p.Limit caps results (max 100, default 20).
func (r *MongoTicketRepository) FindAll(ctx context.Context, p PaginationParams) ([]*Ticket, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	limit := p.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	filter := bson.M{}
	if p.After != "" {
		filter = bson.M{"_id": bson.M{"$gt": p.After}}
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "_id", Value: 1}}).
		SetLimit(int64(limit))

	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("find all tickets: %w", err)
	}
	defer cursor.Close(ctx) //nolint:errcheck

	var tickets []*Ticket
	if err := cursor.All(ctx, &tickets); err != nil {
		return nil, fmt.Errorf("decode tickets: %w", err)
	}
	return tickets, nil
}

// Update uses optimistic concurrency control (OCC) via the version field.
// It atomically increments version and updates updatedAt.
func (r *MongoTicketRepository) Update(ctx context.Context, t *Ticket) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	previousVersion := t.Version
	t.Version++
	t.UpdatedAt = time.Now().UTC()

	filter := bson.M{"_id": t.ID, "version": previousVersion}
	update := bson.M{"$set": bson.M{
		"title":     t.Title,
		"price":     t.Price,
		"orderId":   t.OrderID,
		"version":   t.Version,
		"updatedAt": t.UpdatedAt,
	}}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("update ticket: %w", err)
	}
	if result.MatchedCount == 0 {
		// Distinguish not-found from a concurrent version conflict (C-04):
		// do a follow-up find to check whether the document exists.
		var existing Ticket
		findErr := r.collection.FindOne(ctx, bson.M{"_id": t.ID}).Decode(&existing)
		if errors.Is(findErr, mongo.ErrNoDocuments) {
			return ErrTicketNotFound
		}
		// Document exists but version did not match — concurrent update detected.
		return ErrVersionConflict
	}
	return nil
}

// Ping checks MongoDB connectivity — used by the readiness health check.
func (r *MongoTicketRepository) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return r.client.Ping(ctx, nil)
}

// Close disconnects the MongoDB client gracefully.
func (r *MongoTicketRepository) Close(ctx context.Context) error {
	return r.client.Disconnect(ctx)
}

// ReserveTicket atomically sets orderId on a ticket.
// The filter includes orderId:"" as an OCC guard — if the ticket is already
// reserved (orderId != ""), the update matches nothing and returns ErrTicketReserved.
func (r *MongoTicketRepository) ReserveTicket(ctx context.Context, ticketID, orderID string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// OCC guard: only match tickets that are not yet reserved (orderId is absent or empty string).
	filter := bson.M{
		"_id":     ticketID,
		"orderId": bson.M{"$in": bson.A{"", nil}},
	}
	update := bson.M{
		"$set": bson.M{
			"orderId":   orderID,
			"updatedAt": time.Now().UTC(),
		},
		"$inc": bson.M{"version": 1},
	}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("reserve ticket %s: %w", ticketID, err)
	}
	if result.MatchedCount == 0 {
		// Either the ticket doesn't exist, or it's already reserved — distinguish by FindByID.
		var t Ticket
		findErr := r.collection.FindOne(ctx, bson.M{"_id": ticketID}).Decode(&t)
		if errors.Is(findErr, mongo.ErrNoDocuments) {
			return ErrTicketNotFound
		}
		return ErrTicketReserved
	}
	return nil
}

// ReleaseTicket atomically clears the orderId on a ticket.
// It is idempotent: if orderId is already empty the update is a no-op.
func (r *MongoTicketRepository) ReleaseTicket(ctx context.Context, ticketID string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := bson.M{"_id": ticketID}
	update := bson.M{
		"$unset": bson.M{"orderId": ""},
		"$set":   bson.M{"updatedAt": time.Now().UTC()},
		"$inc":   bson.M{"version": 1},
	}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("release ticket %s: %w", ticketID, err)
	}
	if result.MatchedCount == 0 {
		return ErrTicketNotFound
	}
	return nil
}
