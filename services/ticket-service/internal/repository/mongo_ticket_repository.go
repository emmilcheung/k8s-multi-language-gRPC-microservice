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
//
// Quota fields were added as part of the N-seat quota enhancement (CP-02).
// The Price field migrates from float64 to decimal string to avoid precision drift
// on purchase paths. The OrderID field is kept for backward compatibility during
// rollout but is no longer the primary reservation mechanism.
type Ticket struct {
	ID         string    `bson:"_id"`
	Title      string    `bson:"title"`
	Price      string    `bson:"price"` // decimal string; migrated from float64
	UserID     string    `bson:"userId"`
	OrderID    string    `bson:"orderId,omitempty"` // deprecated: kept for backward compat during migration
	Quota      int       `bson:"quota"`             // total available inventory
	Reserved   int       `bson:"reserved"`          // currently held by active reservations
	Sold       int       `bson:"sold"`              // permanently sold units
	MaxPerUser int       `bson:"maxPerUser"`        // per-user purchase cap
	Version    int       `bson:"version"`
	CreatedAt  time.Time `bson:"createdAt"`
	UpdatedAt  time.Time `bson:"updatedAt"`
}

// ReservationStatus represents the lifecycle state of a TicketReservation.
type ReservationStatus string

const (
	ReservationStatusReserved ReservationStatus = "RESERVED"
	ReservationStatusReleased ReservationStatus = "RELEASED"
	ReservationStatusSold     ReservationStatus = "SOLD"
	ReservationStatusExpired  ReservationStatus = "EXPIRED"
)

// TicketReservation is the durable reservation ledger entry stored in MongoDB.
// Keyed by reservationId (caller-generated UUID) for idempotent retries.
type TicketReservation struct {
	ID        string            `bson:"_id"` // reservationId (UUID, caller-generated)
	TicketID  string            `bson:"ticketId"`
	OrderID   string            `bson:"orderId,omitempty"` // populated on FinalizeReservation
	UserID    string            `bson:"userId"`
	Quantity  int               `bson:"quantity"`
	Status    ReservationStatus `bson:"status"`
	ExpiresAt *time.Time        `bson:"expiresAt,omitempty"` // nil means no expiry
	CreatedAt time.Time         `bson:"createdAt"`
	UpdatedAt time.Time         `bson:"updatedAt"`
}

// ErrTicketNotFound is returned when a ticket does not exist.
var ErrTicketNotFound = errors.New("ticket not found")

// ErrTicketReserved is returned when trying to update a reserved ticket.
var ErrTicketReserved = errors.New("ticket is reserved")

// ErrVersionConflict is returned when an OCC version mismatch is detected (ticket exists
// but was concurrently modified — the caller should retry with fresh data).
var ErrVersionConflict = errors.New("version conflict: ticket was modified concurrently")

// ErrInsufficientQuota is returned when a reserve request exceeds available inventory.
var ErrInsufficientQuota = errors.New("insufficient quota")

// ErrPerUserLimitExceeded is returned when the per-user reservation cap would be breached.
var ErrPerUserLimitExceeded = errors.New("per-user reservation limit exceeded")

// ErrReservationNotFound is returned when a reservation ID does not exist.
var ErrReservationNotFound = errors.New("reservation not found")

// ErrReservationConflict is returned when an operation is invalid for the current reservation state.
var ErrReservationConflict = errors.New("reservation state conflict")

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

	// --- Deprecated single-unit reservation methods (kept for backward compat) ---

	// ReserveTicket sets the orderId on a ticket (idempotent).
	ReserveTicket(ctx context.Context, ticketID, orderID string) error
	// ReleaseTicket clears the orderId on a ticket (idempotent).
	ReleaseTicket(ctx context.Context, ticketID string) error

	// --- Quota-based reservation methods (CP-02) ---

	// CreateReservation atomically decrements the ticket's available counter and
	// writes a durable TicketReservation record. Returns ErrInsufficientQuota
	// if quota - reserved - sold < quantity, or ErrPerUserLimitExceeded if the
	// per-user cap would be breached.
	CreateReservation(ctx context.Context, r *TicketReservation) error

	// FindReservationByID returns the reservation for the given reservationId.
	FindReservationByID(ctx context.Context, reservationID string) (*TicketReservation, error)

	// ReleaseReservation transitions a RESERVED reservation to RELEASED and
	// increments the ticket's reserved counter back. Idempotent: releasing an
	// already-RELEASED reservation is a no-op success.
	ReleaseReservation(ctx context.Context, reservationID string) error

	// FinalizeReservation transitions a RESERVED reservation to SOLD, sets the
	// orderId on the reservation, and decrements reserved while incrementing sold
	// on the ticket document. Idempotent: finalizing an already-SOLD reservation
	// is a no-op success.
	FinalizeReservation(ctx context.Context, reservationID, orderID string) error

	Ping(ctx context.Context) error
	Close(ctx context.Context) error
}

// MongoTicketRepository implements TicketRepository against MongoDB.
type MongoTicketRepository struct {
	client       *mongo.Client
	collection   *mongo.Collection
	reservations *mongo.Collection
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
	resvColl := db.Collection("ticket_reservations")

	// Enforce JSON schema validation on the tickets collection
	if err := ensureCollectionSchema(ctx, db, coll); err != nil {
		return nil, fmt.Errorf("ensure schema: %w", err)
	}

	// Enforce JSON schema validation on the reservations collection
	if err := ensureReservationCollectionSchema(ctx, db, resvColl); err != nil {
		return nil, fmt.Errorf("ensure reservation schema: %w", err)
	}

	// Create indexes for both collections
	if err := ensureIndexes(ctx, coll); err != nil {
		return nil, fmt.Errorf("ensure indexes: %w", err)
	}
	if err := ensureReservationIndexes(ctx, resvColl); err != nil {
		return nil, fmt.Errorf("ensure reservation indexes: %w", err)
	}

	return &MongoTicketRepository{
		client:       client,
		collection:   coll,
		reservations: resvColl,
	}, nil
}

func ensureCollectionSchema(ctx context.Context, db *mongo.Database, coll *mongo.Collection) error {
	validator := bson.D{
		{Key: "$jsonSchema", Value: bson.D{
			{Key: "bsonType", Value: "object"},
			{Key: "required", Value: bson.A{"_id", "title", "price", "userId", "quota", "reserved", "sold", "maxPerUser", "version", "createdAt", "updatedAt"}},
			{Key: "properties", Value: bson.D{
				{Key: "_id", Value: bson.D{{Key: "bsonType", Value: "string"}}},
				{Key: "title", Value: bson.D{
					{Key: "bsonType", Value: "string"},
					{Key: "minLength", Value: 1},
					{Key: "maxLength", Value: 200},
				}},
				{Key: "price", Value: bson.D{
					{Key: "bsonType", Value: "string"},
					{Key: "minLength", Value: 1},
				}},
				{Key: "userId", Value: bson.D{{Key: "bsonType", Value: "string"}}},
				{Key: "quota", Value: bson.D{
					{Key: "bsonType", Value: "int"},
					{Key: "minimum", Value: 1},
				}},
				{Key: "reserved", Value: bson.D{
					{Key: "bsonType", Value: "int"},
					{Key: "minimum", Value: 0},
				}},
				{Key: "sold", Value: bson.D{
					{Key: "bsonType", Value: "int"},
					{Key: "minimum", Value: 0},
				}},
				{Key: "maxPerUser", Value: bson.D{
					{Key: "bsonType", Value: "int"},
					{Key: "minimum", Value: 1},
				}},
				{Key: "version", Value: bson.D{{Key: "bsonType", Value: "int"}}},
			}},
		}},
	}

	// Try to create the collection with the schema; ignore "already exists" error.
	createOpts := options.CreateCollection().SetValidator(validator)
	err := db.CreateCollection(ctx, "tickets", createOpts)
	if err != nil {
		var cmdErr mongo.CommandError
		if !errors.As(err, &cmdErr) || cmdErr.Code != 48 {
			return fmt.Errorf("create collection: %w", err)
		}
		// Code 48 = NamespaceExists — collection already exists, apply validator via collMod
		cmd := bson.D{
			{Key: "collMod", Value: "tickets"},
			{Key: "validator", Value: validator},
			{Key: "validationLevel", Value: "strict"},
		}
		if modErr := db.RunCommand(ctx, cmd).Err(); modErr != nil {
			return fmt.Errorf("collMod: %w", modErr)
		}
	}
	return nil
}

func ensureReservationCollectionSchema(ctx context.Context, db *mongo.Database, coll *mongo.Collection) error {
	validator := bson.D{
		{Key: "$jsonSchema", Value: bson.D{
			{Key: "bsonType", Value: "object"},
			{Key: "required", Value: bson.A{"_id", "ticketId", "userId", "quantity", "status", "createdAt", "updatedAt"}},
			{Key: "properties", Value: bson.D{
				{Key: "_id", Value: bson.D{{Key: "bsonType", Value: "string"}}},
				{Key: "ticketId", Value: bson.D{{Key: "bsonType", Value: "string"}}},
				{Key: "userId", Value: bson.D{{Key: "bsonType", Value: "string"}}},
				{Key: "quantity", Value: bson.D{
					{Key: "bsonType", Value: "int"},
					{Key: "minimum", Value: 1},
				}},
				{Key: "status", Value: bson.D{
					{Key: "bsonType", Value: "string"},
					{Key: "enum", Value: bson.A{"RESERVED", "RELEASED", "SOLD", "EXPIRED"}},
				}},
			}},
		}},
	}

	createOpts := options.CreateCollection().SetValidator(validator)
	err := db.CreateCollection(ctx, coll.Name(), createOpts)
	if err != nil {
		var cmdErr mongo.CommandError
		if !errors.As(err, &cmdErr) || cmdErr.Code != 48 {
			return fmt.Errorf("create collection: %w", err)
		}
		// Code 48 = NamespaceExists — collection already exists, apply validator via collMod
		cmd := bson.D{
			{Key: "collMod", Value: coll.Name()},
			{Key: "validator", Value: validator},
			{Key: "validationLevel", Value: "strict"},
		}
		if modErr := db.RunCommand(ctx, cmd).Err(); modErr != nil {
			return fmt.Errorf("collMod: %w", modErr)
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

func ensureReservationIndexes(ctx context.Context, coll *mongo.Collection) error {
	_, err := coll.Indexes().CreateMany(ctx, []mongo.IndexModel{
		// Primary lookup by reservationId is handled by the _id index.
		// Composite index for per-ticket and per-user reservation queries.
		{
			Keys:    bson.D{{Key: "ticketId", Value: 1}, {Key: "status", Value: 1}},
			Options: options.Index().SetName("idx_ticketId_status"),
		},
		{
			Keys:    bson.D{{Key: "userId", Value: 1}, {Key: "ticketId", Value: 1}, {Key: "status", Value: 1}},
			Options: options.Index().SetName("idx_userId_ticketId_status"),
		},
		// Sparse index for finalized reservations — orderId is only set post-finalization.
		{
			Keys:    bson.D{{Key: "orderId", Value: 1}},
			Options: options.Index().SetName("idx_orderId_sparse").SetSparse(true),
		},
		// TTL-style index for expiry sweeper — used by the reconciliation worker.
		{
			Keys:    bson.D{{Key: "expiresAt", Value: 1}},
			Options: options.Index().SetName("idx_expiresAt").SetSparse(true),
		},
	})
	return err
}

// Create inserts a new ticket, generating a UUID if ID is empty.
// Quota defaults: Quota=1, Reserved=0, Sold=0, MaxPerUser=1 if not supplied by caller.
func (r *MongoTicketRepository) Create(ctx context.Context, t *Ticket) error {
	if t.ID == "" {
		t.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	t.CreatedAt = now
	t.UpdatedAt = now
	t.Version = 1

	// Apply quota defaults for tickets that don't specify them (backward compat).
	if t.Quota == 0 {
		t.Quota = 1
	}
	if t.MaxPerUser == 0 {
		t.MaxPerUser = 1
	}

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
// Only title, price, quota, maxPerUser, and orderId are mutable via this method;
// reserved and sold counters are managed exclusively by the reservation methods.
func (r *MongoTicketRepository) Update(ctx context.Context, t *Ticket) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	previousVersion := t.Version
	t.Version++
	t.UpdatedAt = time.Now().UTC()

	filter := bson.M{"_id": t.ID, "version": previousVersion}
	update := bson.M{"$set": bson.M{
		"title":      t.Title,
		"price":      t.Price,
		"orderId":    t.OrderID,
		"quota":      t.Quota,
		"maxPerUser": t.MaxPerUser,
		"version":    t.Version,
		"updatedAt":  t.UpdatedAt,
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

// ─── Quota-based reservation methods ─────────────────────────────────────────

// CreateReservation writes a new TicketReservation to MongoDB and atomically
// increments the ticket's reserved counter inside a multi-document transaction.
//
// Returns ErrTicketNotFound if the ticket does not exist.
// Returns ErrInsufficientQuota if quota - reserved - sold < quantity.
// Returns ErrPerUserLimitExceeded if the per-user cap would be breached.
func (r *MongoTicketRepository) CreateReservation(ctx context.Context, res *TicketReservation) error {
	now := time.Now().UTC()
	if res.CreatedAt.IsZero() {
		res.CreatedAt = now
	}
	res.UpdatedAt = now
	res.Status = ReservationStatusReserved

	sess, err := r.client.StartSession()
	if err != nil {
		return fmt.Errorf("CreateReservation start session: %w", err)
	}
	defer sess.EndSession(ctx)

	_, txErr := sess.WithTransaction(ctx, func(sessCtx context.Context) (interface{}, error) {
		// 1. Read ticket and check inventory (inside transaction for consistency).
		var ticket Ticket
		findErr := r.collection.FindOne(sessCtx, bson.M{"_id": res.TicketID}).Decode(&ticket)
		if errors.Is(findErr, mongo.ErrNoDocuments) {
			return nil, ErrTicketNotFound
		}
		if findErr != nil {
			return nil, fmt.Errorf("find ticket: %w", findErr)
		}

		available := ticket.Quota - ticket.Reserved - ticket.Sold
		if available < res.Quantity {
			return nil, ErrInsufficientQuota
		}

		// 2. Check per-user limit.
		userActive, sumErr := r.sumUserActiveReservations(sessCtx, res.TicketID, res.UserID)
		if sumErr != nil {
			return nil, fmt.Errorf("check per-user limit: %w", sumErr)
		}
		if userActive+res.Quantity > ticket.MaxPerUser {
			return nil, ErrPerUserLimitExceeded
		}

		// 3. Insert reservation document.
		if _, insErr := r.reservations.InsertOne(sessCtx, res); insErr != nil {
			return nil, fmt.Errorf("insert reservation: %w", insErr)
		}

		// 4. Increment ticket reserved counter with an $expr guard to prevent
		// concurrent calls from overshooting quota (belt-and-suspenders alongside the tx).
		ticketFilter := bson.M{
			"_id": res.TicketID,
			"$expr": bson.M{
				"$lte": bson.A{
					bson.M{"$add": bson.A{"$reserved", "$sold", res.Quantity}},
					"$quota",
				},
			},
		}
		ticketUpdate := bson.M{
			"$inc": bson.M{"reserved": res.Quantity, "version": 1},
			"$set": bson.M{"updatedAt": now},
		}
		result, updErr := r.collection.UpdateOne(sessCtx, ticketFilter, ticketUpdate)
		if updErr != nil {
			return nil, fmt.Errorf("increment ticket reserved counter: %w", updErr)
		}
		if result.MatchedCount == 0 {
			// Filter did not match: concurrent write exhausted quota between our read and write.
			return nil, ErrInsufficientQuota
		}

		return nil, nil
	})
	return txErr
}

// sumUserActiveReservations returns the total quantity of RESERVED reservations
// by the given user for the given ticket.
func (r *MongoTicketRepository) sumUserActiveReservations(ctx context.Context, ticketID, userID string) (int, error) {
	filter := bson.M{
		"ticketId": ticketID,
		"userId":   userID,
		"status":   ReservationStatusReserved,
	}

	cursor, err := r.reservations.Find(ctx, filter)
	if err != nil {
		return 0, fmt.Errorf("find user reservations: %w", err)
	}
	defer cursor.Close(ctx) //nolint:errcheck

	var total int
	for cursor.Next(ctx) {
		var item TicketReservation
		if err := cursor.Decode(&item); err != nil {
			return 0, fmt.Errorf("decode reservation: %w", err)
		}
		total += item.Quantity
	}
	return total, cursor.Err()
}

// FindReservationByID returns the reservation for the given reservationId.
func (r *MongoTicketRepository) FindReservationByID(ctx context.Context, reservationID string) (*TicketReservation, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var res TicketReservation
	err := r.reservations.FindOne(ctx, bson.M{"_id": reservationID}).Decode(&res)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrReservationNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find reservation by id: %w", err)
	}
	return &res, nil
}

// ReleaseReservation transitions a RESERVED reservation to RELEASED and
// decrements the ticket's reserved counter inside a transaction. Idempotent for RELEASED or EXPIRED.
func (r *MongoTicketRepository) ReleaseReservation(ctx context.Context, reservationID string) error {
	// Read the reservation outside the transaction for a fast early-exit on not-found / wrong state.
	res, err := r.FindReservationByID(ctx, reservationID)
	if err != nil {
		return err
	}

	switch res.Status {
	case ReservationStatusReleased, ReservationStatusExpired:
		return nil // idempotent no-op
	case ReservationStatusSold:
		return ErrReservationConflict
	case ReservationStatusReserved:
		// proceed
	}

	sess, err := r.client.StartSession()
	if err != nil {
		return fmt.Errorf("ReleaseReservation start session: %w", err)
	}
	defer sess.EndSession(ctx)

	now := time.Now().UTC()

	_, txErr := sess.WithTransaction(ctx, func(sessCtx context.Context) (interface{}, error) {
		// Re-check status inside transaction to guard against concurrent release.
		var current TicketReservation
		findErr := r.reservations.FindOne(sessCtx, bson.M{"_id": reservationID}).Decode(&current)
		if errors.Is(findErr, mongo.ErrNoDocuments) {
			return nil, ErrReservationNotFound
		}
		if findErr != nil {
			return nil, fmt.Errorf("re-read reservation: %w", findErr)
		}
		switch current.Status {
		case ReservationStatusReleased, ReservationStatusExpired:
			return nil, nil // concurrent release already succeeded
		case ReservationStatusSold:
			return nil, ErrReservationConflict
		}

		// Update reservation to RELEASED.
		resvUpdate := bson.M{"$set": bson.M{"status": ReservationStatusReleased, "updatedAt": now}}
		if _, updErr := r.reservations.UpdateOne(sessCtx, bson.M{"_id": reservationID}, resvUpdate); updErr != nil {
			return nil, fmt.Errorf("update reservation to RELEASED: %w", updErr)
		}

		// Decrement ticket reserved counter.
		ticketUpdate := bson.M{
			"$inc": bson.M{"reserved": -current.Quantity, "version": 1},
			"$set": bson.M{"updatedAt": now},
		}
		if _, updErr := r.collection.UpdateOne(sessCtx, bson.M{"_id": current.TicketID}, ticketUpdate); updErr != nil {
			return nil, fmt.Errorf("decrement ticket reserved counter on release: %w", updErr)
		}

		return nil, nil
	})
	return txErr
}

// FinalizeReservation transitions a RESERVED reservation to SOLD, sets orderId,
// and moves quantity from reserved to sold on the ticket inside a transaction. Idempotent for SOLD.
func (r *MongoTicketRepository) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	// Read outside transaction for fast early-exit.
	res, err := r.FindReservationByID(ctx, reservationID)
	if err != nil {
		return err
	}

	switch res.Status {
	case ReservationStatusSold:
		return nil // idempotent no-op
	case ReservationStatusReleased, ReservationStatusExpired:
		return ErrReservationConflict
	case ReservationStatusReserved:
		// proceed
	}

	sess, err := r.client.StartSession()
	if err != nil {
		return fmt.Errorf("FinalizeReservation start session: %w", err)
	}
	defer sess.EndSession(ctx)

	now := time.Now().UTC()

	_, txErr := sess.WithTransaction(ctx, func(sessCtx context.Context) (interface{}, error) {
		// Re-check inside transaction.
		var current TicketReservation
		findErr := r.reservations.FindOne(sessCtx, bson.M{"_id": reservationID}).Decode(&current)
		if errors.Is(findErr, mongo.ErrNoDocuments) {
			return nil, ErrReservationNotFound
		}
		if findErr != nil {
			return nil, fmt.Errorf("re-read reservation: %w", findErr)
		}
		switch current.Status {
		case ReservationStatusSold:
			return nil, nil // concurrent finalize already succeeded
		case ReservationStatusReleased, ReservationStatusExpired:
			return nil, ErrReservationConflict
		}

		// Update reservation to SOLD with orderID.
		resvUpdate := bson.M{
			"$set": bson.M{
				"status":    ReservationStatusSold,
				"orderId":   orderID,
				"updatedAt": now,
			},
		}
		if _, updErr := r.reservations.UpdateOne(sessCtx, bson.M{"_id": reservationID}, resvUpdate); updErr != nil {
			return nil, fmt.Errorf("update reservation to SOLD: %w", updErr)
		}

		// Move quantity from reserved to sold.
		ticketUpdate := bson.M{
			"$inc": bson.M{"reserved": -current.Quantity, "sold": current.Quantity, "version": 1},
			"$set": bson.M{"updatedAt": now},
		}
		if _, updErr := r.collection.UpdateOne(sessCtx, bson.M{"_id": current.TicketID}, ticketUpdate); updErr != nil {
			return nil, fmt.Errorf("update ticket counters on finalize: %w", updErr)
		}

		return nil, nil
	})
	return txErr
}
