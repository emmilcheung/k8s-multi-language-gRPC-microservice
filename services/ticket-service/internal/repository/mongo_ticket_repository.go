package repository

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/acme/ticket-service/internal/cache"
	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// EncodeCursor encodes a (createdAt, id) pair as a compound cursor string.
func EncodeCursor(createdAt time.Time, id string) string {
	return fmt.Sprintf("%d:%s", createdAt.UnixMilli(), id)
}

// parseCursor decodes a compound cursor produced by EncodeCursor.
func parseCursor(after string) (ms int64, id string, ok bool) {
	idx := strings.IndexByte(after, ':')
	if idx < 1 {
		return 0, "", false
	}
	ms, err := strconv.ParseInt(after[:idx], 10, 64)
	if err != nil {
		return 0, "", false
	}
	return ms, after[idx+1:], true
}

// TicketEvent is the event sub-document stored within a Ticket, containing event metadata.
// This denormalized structure allows sellers to associate every ticket with event details
// that buyers see on listings and in order confirmations without requiring cross-service joins.
// WS8: Event metadata added to support ticketing platform revamp.
type TicketEvent struct {
	Title        string     `bson:"title"`                   // e.g. "Taylor Swift – Eras Tour"
	Description  string     `bson:"description,omitempty"`   // optional event description
	StartsAt     time.Time  `bson:"starts_at"`               // required; event start time
	EndsAt       *time.Time `bson:"ends_at,omitempty"`       // optional; event end time
	ImageURL     string     `bson:"image_url,omitempty"`     // optional; event poster/banner
	VenueName    string     `bson:"venue_name,omitempty"`    // denormalized from venue-service
	VenueAddress string     `bson:"venue_address,omitempty"` // denormalized from venue-service
}

// Ticket is the domain model stored in MongoDB.
//
// Quota fields were added as part of the N-seat quota enhancement (CP-02).
// The Price field migrates from float64 to decimal string to avoid precision drift
// on purchase paths. The OrderID field is kept for backward compatibility during
// rollout but is no longer the primary reservation mechanism.
//
// SeatingPlanID (CP-13): when non-empty the ticket is a "seated" ticket linked
// to a venue-service seating plan. Seated tickets bypass the GA quota path —
// inventory is managed by the venue-service seat reservation instead.
//
// TicketType (WS3): denormalizes the assignment mode from the linked seating plan.
// Valid values: "GA", "SEATED_MANUAL", "SEATED_AUTO". Empty string on create;
// populated when ticket is attached to a plan.
type Ticket struct {
	ID            string              `bson:"_id"`
	Title         string              `bson:"title"`
	Price         string              `bson:"price"` // decimal string; migrated from float64
	UserID        string              `bson:"userId"`
	OrderID       string              `bson:"orderId,omitempty"`       // deprecated: kept for backward compat during migration
	SeatingPlanID string              `bson:"seatingPlanId,omitempty"` // CP-13: venue seating plan UUID; empty = GA ticket
	TicketType    string              `bson:"ticket_type,omitempty"`   // WS3: "GA" | "SEATED_MANUAL" | "SEATED_AUTO"
	Quota         int                 `bson:"quota"`                   // total available inventory (GA tickets only)
	Reserved      int                 `bson:"reserved"`                // currently held by active reservations
	Sold          int                 `bson:"sold"`                    // permanently sold units
	MaxPerUser    int                 `bson:"maxPerUser"`              // per-user purchase cap
	Version       int                 `bson:"version"`
	CreatedAt     time.Time           `bson:"createdAt"`
	UpdatedAt     time.Time           `bson:"updatedAt"`
	Event         *TicketEvent        `bson:"event,omitempty"` // WS8: nullable; old tickets have nil
	Outbox        []TicketOutboxEvent `bson:"outbox,omitempty" json:"-"`
	PendingOutbox []TicketOutboxEvent `bson:"-" json:"-"`
}

// OutboxEventType identifies the durable ticket event queued for relay.
type OutboxEventType string

const (
	OutboxEventTypeTicketCreated OutboxEventType = "tickets.ticket.created"
	OutboxEventTypeTicketUpdated OutboxEventType = "tickets.ticket.updated"
)

// TicketOutboxPayload is the durable Kafka payload written with the ticket mutation.
type TicketOutboxPayload struct {
	ID            string              `bson:"id"`
	Title         string              `bson:"title"`
	Price         string              `bson:"price"`
	UserID        string              `bson:"userId"`
	SeatingPlanID string              `bson:"seatingPlanId,omitempty"`
	TicketType    string              `bson:"ticketType,omitempty"`
	Version       int                 `bson:"version"`
	Event         *TicketOutboxDetail `bson:"event,omitempty"`
}

// TicketOutboxDetail stores optional event metadata in durable form.
type TicketOutboxDetail struct {
	Title        string `bson:"title,omitempty"`
	Description  string `bson:"description,omitempty"`
	StartsAt     string `bson:"startsAt"`
	EndsAt       string `bson:"endsAt,omitempty"`
	ImageURL     string `bson:"imageUrl,omitempty"`
	VenueName    string `bson:"venueName,omitempty"`
	VenueAddress string `bson:"venueAddress,omitempty"`
}

// TicketOutboxEvent is a durable relay record embedded in the ticket document.
type TicketOutboxEvent struct {
	ID            string              `bson:"id" json:"-"`
	Type          OutboxEventType     `bson:"type" json:"-"`
	Payload       TicketOutboxPayload `bson:"payload" json:"-"`
	Attempts      int                 `bson:"attempts" json:"-"`
	NextAttemptAt time.Time           `bson:"nextAttemptAt" json:"-"`
	CreatedAt     time.Time           `bson:"createdAt" json:"-"`
	ClaimToken    string              `bson:"claimToken,omitempty" json:"-"`
	LeaseUntil    *time.Time          `bson:"leaseUntil,omitempty" json:"-"`
	LastError     string              `bson:"lastError,omitempty" json:"-"`
}

// ClaimedOutboxEvent is a flattened relay work item claimed from a ticket document.
type ClaimedOutboxEvent struct {
	TicketID string
	Event    TicketOutboxEvent
}

// NewTicketOutboxEvent creates a durable outbox entry ready for relay.
func NewTicketOutboxEvent(eventType OutboxEventType, payload TicketOutboxPayload) TicketOutboxEvent {
	now := time.Now().UTC()
	return TicketOutboxEvent{
		ID:            uuid.NewString(),
		Type:          eventType,
		Payload:       payload,
		NextAttemptAt: now,
		CreatedAt:     now,
	}
}

func normalizePendingOutboxEvent(ticket *Ticket, event *TicketOutboxEvent) {
	event.Payload.ID = ticket.ID
	event.Payload.Title = ticket.Title
	event.Payload.Price = ticket.Price
	event.Payload.UserID = ticket.UserID
	event.Payload.SeatingPlanID = ticket.SeatingPlanID
	event.Payload.TicketType = ticket.TicketType
	event.Payload.Version = ticket.Version
	if ticket.Event != nil && event.Payload.Event == nil {
		var endsAt string
		if ticket.Event.EndsAt != nil {
			endsAt = ticket.Event.EndsAt.Format(time.RFC3339)
		}
		event.Payload.Event = &TicketOutboxDetail{
			Title:        ticket.Event.Title,
			Description:  ticket.Event.Description,
			StartsAt:     ticket.Event.StartsAt.Format(time.RFC3339),
			EndsAt:       endsAt,
			ImageURL:     ticket.Event.ImageURL,
			VenueName:    ticket.Event.VenueName,
			VenueAddress: ticket.Event.VenueAddress,
		}
	}
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

// ErrSeatedTicket is returned when a GA quota operation is attempted on a seated ticket.
// Seated tickets are managed exclusively by the venue-service reservation path (CP-13).
var ErrSeatedTicket = errors.New("ticket is seated — use venue-service reservation path")

// ErrSeatingPlanAlreadyAttached is returned when a seating plan is attached to a ticket
// that already has one. Callers should detach first.
var ErrSeatingPlanAlreadyAttached = errors.New("ticket already has an attached seating plan")

// ErrOwnership is returned by AttachSeatingPlan / DetachSeatingPlan when the caller
// does not own the ticket. Distinct from service.ErrUnauthorized so that repository
// callers can check it without importing the service package.
var ErrOwnership = errors.New("caller does not own this ticket")

// PaginationParams controls cursor-based pagination for FindAll.
// After is an opaque compound cursor of the form "<createdAtUnixMilli>:<id>"
// representing the last ticket seen on the previous page (newest-first order).
// Limit is the maximum number of tickets to return (capped at 100; 0 means 20).
// AvailableOnly filters to show only available tickets: GA tickets with sold < quota,
// and SEATED tickets that are not fully booked.
type PaginationParams struct {
	After         string // compound cursor "<unixMilli>:<id>"; empty = start from beginning
	Limit         int    // max results per page
	AvailableOnly bool   // if true, filter out sold-out tickets
}

// TicketRepository defines the storage interface.
type TicketRepository interface {
	Create(ctx context.Context, t *Ticket) error
	FindByID(ctx context.Context, id string) (*Ticket, error)
	// FindAll returns a page of tickets ordered by createdAt descending (newest first).
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

	// --- Seating plan attachment (CP-13) ---

	// AttachSeatingPlan atomically sets seatingPlanId and ticketType on a ticket in a
	// single MongoDB update. The caller must own the ticket. Returns ErrTicketNotFound
	// if the ticket does not exist, ErrOwnership if the user doesn't own it, and
	// ErrSeatingPlanAlreadyAttached if a plan is already attached.
	AttachSeatingPlan(ctx context.Context, ticketID, planID, userID, ticketType string, outbox *TicketOutboxEvent) error

	// DetachSeatingPlan clears both seatingPlanId and ticketType from a ticket. The
	// caller must own the ticket. Idempotent: if no plan is attached this is a no-op.
	DetachSeatingPlan(ctx context.Context, ticketID, userID string, outbox *TicketOutboxEvent) error
}

// MongoTicketRepository implements TicketRepository against MongoDB.
type MongoTicketRepository struct {
	client       *mongo.Client
	collection   *mongo.Collection
	reservations *mongo.Collection
	quota        cache.QuotaManager // optional; nil means no Redis quota gate
}

// Option is a functional option for NewMongoTicketRepository.
type Option func(*MongoTicketRepository)

// WithQuotaManager attaches a Redis QuotaManager to the repository.
// When set, CreateReservation / ReleaseReservation / FinalizeReservation use
// Redis Lua scripts as the hot-path gate; Mongo remains the source of truth.
func WithQuotaManager(qm cache.QuotaManager) Option {
	return func(r *MongoTicketRepository) { r.quota = qm }
}

// NewMongoTicketRepository creates a new repository, verifying connectivity at construction time.
func NewMongoTicketRepository(ctx context.Context, uri, dbName string, opts ...Option) (*MongoTicketRepository, error) {
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

	repo := &MongoTicketRepository{
		client:       client,
		collection:   coll,
		reservations: resvColl,
	}
	for _, o := range opts {
		o(repo)
	}
	return repo, nil
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
				// seatingPlanId is optional — present only for seated tickets (CP-13).
				{Key: "seatingPlanId", Value: bson.D{{Key: "bsonType", Value: "string"}}},
			}},
		}},
	}
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
		// Sparse index for seating plan lookups — only present on seated tickets (CP-13).
		{
			Keys:    bson.D{{Key: "seatingPlanId", Value: 1}},
			Options: options.Index().SetName("idx_seatingPlanId").SetSparse(true),
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
	if len(t.PendingOutbox) > 0 {
		for index := range t.PendingOutbox {
			normalizePendingOutboxEvent(t, &t.PendingOutbox[index])
		}
		t.Outbox = append(t.Outbox, t.PendingOutbox...)
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err := r.collection.InsertOne(ctx, t)
	if err != nil {
		return fmt.Errorf("insert ticket: %w", err)
	}

	// Seed Redis availability counter after durable write succeeds.
	// Use force=false so a key that survived a previous create (e.g. retry) is not reset.
	if r.quota != nil {
		available := t.Quota - t.Reserved - t.Sold
		if seedErr := r.quota.Seed(ctx, t.ID, available, false); seedErr != nil {
			// Non-fatal: Redis will be re-seeded by the reconciliation worker.
			// Log here would be ideal; for now return the error so callers are aware.
			return fmt.Errorf("seed redis quota: %w", seedErr)
		}
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

// FindAll returns a page of tickets ordered by createdAt descending (newest first).
// p.After is a compound cursor "<createdAtUnixMilli>:<id>" from the last ticket seen.
// p.Limit caps results (max 100, default 20).
func (r *MongoTicketRepository) FindAll(ctx context.Context, p PaginationParams) ([]*Ticket, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	limit := p.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	filter := bson.M{}
	if p.After != "" {
		if ms, id, ok := parseCursor(p.After); ok {
			cursorTime := time.UnixMilli(ms).UTC()
			filter = bson.M{"$or": bson.A{
				bson.M{"createdAt": bson.M{"$lt": cursorTime}},
				bson.M{"createdAt": cursorTime, "_id": bson.M{"$lt": id}},
			}}
		}
	}

	// Apply availability filter if requested.
	// For GA tickets: sold < quota (has remaining inventory).
	// For SEATED tickets: seatingPlanId must be non-empty (availability managed by venue-service).
	// We filter out fully-sold GA tickets; seated tickets are assumed available if linked to a plan.
	if p.AvailableOnly {
		filter["$expr"] = bson.M{
			"$or": bson.A{
				// GA tickets: must have sold < quota (available inventory)
				bson.M{"$lt": bson.A{"$sold", "$quota"}},
				// SEATED tickets: must have a seatingPlanId (availability managed by venue-service)
				bson.M{"$ne": bson.A{"$seatingPlanId", ""}},
			},
		}
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).
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
	if len(t.PendingOutbox) > 0 {
		for index := range t.PendingOutbox {
			normalizePendingOutboxEvent(t, &t.PendingOutbox[index])
		}
	}

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
	if len(t.PendingOutbox) > 0 {
		update["$push"] = bson.M{"outbox": bson.M{"$each": t.PendingOutbox}}
	}

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
// increments the ticket's reserved counter using a single findOneAndUpdate with
// an $expr guard. No multi-document transaction is used so this works on
// standalone MongoDB instances (including local Docker Compose).
//
// Atomicity guarantee: the ticket counter increment uses a conditional filter
// ($expr: reserved + sold + quantity <= quota) so concurrent over-reservation
// is prevented at the document level. The reservation insert that follows is
// best-effort — if it fails the ticket counter is compensated via a follow-up
// decrement. Redis is used as a fast pre-check gate when available.
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

	// ── Redis hot-path gate ────────────────────────────────────────────────────
	// When Redis is available, reject obvious quota/limit violations before
	// hitting Mongo. This reduces write amplification on sold-out tickets and
	// provides low-latency feedback to callers.
	//
	// If the availability key is not initialised (ErrKeyNotInitialised) we fall
	// through to Mongo — the reservation ledger is authoritative.
	var redisReserved bool
	if r.quota != nil {
		var maxPerUser int
		if t, findErr := r.FindByID(ctx, res.TicketID); findErr == nil {
			maxPerUser = t.MaxPerUser
		}
		// maxPerUser == 0 means the ticket was not found; Mongo will return
		// ErrTicketNotFound below — no need to call Redis.
		if maxPerUser > 0 {
			redisErr := r.quota.Reserve(ctx, res.TicketID, res.UserID, res.Quantity, maxPerUser)
			switch {
			case errors.Is(redisErr, cache.ErrKeyNotInitialised):
				// Key absent — fall through to Mongo; do not set redisReserved.
			case errors.Is(redisErr, cache.ErrQuotaInsufficient):
				return ErrInsufficientQuota
			case errors.Is(redisErr, cache.ErrUserLimitExceeded):
				return ErrPerUserLimitExceeded
			case redisErr != nil:
				return fmt.Errorf("redis reserve: %w", redisErr)
			default:
				redisReserved = true
			}
		}
	}

	// ── Quota availability + per-user limit check (Mongo reads) ──────────────
	// Read the ticket first to check both available inventory and the per-user cap.
	// Quota insufficiency is checked before the per-user cap so that the most
	// fundamental constraint (not enough inventory) takes precedence when both
	// would fire simultaneously. This is a non-transactional read-then-write;
	// the Redis gate above covers the concurrent case for the hot path.
	ticket, findErr := r.FindByID(ctx, res.TicketID)
	if findErr != nil {
		if redisReserved {
			_ = r.quota.Release(ctx, res.TicketID, res.UserID, res.Quantity)
		}
		return findErr // ErrTicketNotFound or wrapped error
	}

	// Check overall quota first — if there is not enough inventory this takes
	// precedence over the per-user cap.
	available := ticket.Quota - ticket.Reserved - ticket.Sold
	if available < res.Quantity {
		if redisReserved {
			_ = r.quota.Release(ctx, res.TicketID, res.UserID, res.Quantity)
		}
		return ErrInsufficientQuota
	}

	userActive, sumErr := r.sumUserActiveReservations(ctx, res.TicketID, res.UserID)
	if sumErr != nil {
		if redisReserved {
			_ = r.quota.Release(ctx, res.TicketID, res.UserID, res.Quantity)
		}
		return fmt.Errorf("check per-user limit: %w", sumErr)
	}
	if userActive+res.Quantity > ticket.MaxPerUser {
		if redisReserved {
			_ = r.quota.Release(ctx, res.TicketID, res.UserID, res.Quantity)
		}
		return ErrPerUserLimitExceeded
	}

	// ── Atomic ticket counter increment ───────────────────────────────────────
	// Use findOneAndUpdate with a conditional $expr filter as a single atomic
	// operation. If the filter doesn't match (ticket not found or quota
	// exhausted), we disambiguate with a follow-up read.
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
	result, updErr := r.collection.UpdateOne(ctx, ticketFilter, ticketUpdate)
	if updErr != nil {
		if redisReserved {
			_ = r.quota.Release(ctx, res.TicketID, res.UserID, res.Quantity)
		}
		return fmt.Errorf("increment ticket reserved counter: %w", updErr)
	}
	if result.MatchedCount == 0 {
		// Filter did not match — either the ticket disappeared or quota is now exhausted.
		if redisReserved {
			_ = r.quota.Release(ctx, res.TicketID, res.UserID, res.Quantity)
		}
		return ErrInsufficientQuota
	}

	// ── Insert reservation document ───────────────────────────────────────────
	// The ticket counter is already incremented. If the insert fails we must
	// compensate by decrementing the counter.
	if _, insErr := r.reservations.InsertOne(ctx, res); insErr != nil {
		// Compensate: roll back the ticket counter increment.
		compensateFilter := bson.M{"_id": res.TicketID}
		compensateUpdate := bson.M{
			"$inc": bson.M{"reserved": -res.Quantity, "version": 1},
			"$set": bson.M{"updatedAt": time.Now().UTC()},
		}
		_, _ = r.collection.UpdateOne(ctx, compensateFilter, compensateUpdate)
		if redisReserved {
			_ = r.quota.Release(ctx, res.TicketID, res.UserID, res.Quantity)
		}
		return fmt.Errorf("insert reservation: %w", insErr)
	}

	return nil
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
// decrements the ticket's reserved counter. Uses atomic findOneAndUpdate on the
// reservation document (status filter: RESERVED→RELEASED) to guard against
// concurrent releases; no multi-document transaction is required.
// Idempotent for RELEASED or EXPIRED.
func (r *MongoTicketRepository) ReleaseReservation(ctx context.Context, reservationID string) error {
	now := time.Now().UTC()

	// Atomically transition the reservation from RESERVED to RELEASED.
	// The filter on status:"RESERVED" means only one concurrent caller succeeds;
	// the other sees MatchedCount==0 and treats it as an idempotent no-op.
	resvFilter := bson.M{"_id": reservationID, "status": ReservationStatusReserved}
	resvUpdate := bson.M{"$set": bson.M{"status": ReservationStatusReleased, "updatedAt": now}}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var updated TicketReservation
	err := r.reservations.FindOneAndUpdate(ctx, resvFilter, resvUpdate, opts).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		// Either the reservation does not exist, or it is not in RESERVED state.
		// Check what state it is actually in to give the right error.
		res, findErr := r.FindReservationByID(ctx, reservationID)
		if errors.Is(findErr, ErrReservationNotFound) {
			return ErrReservationNotFound
		}
		if findErr != nil {
			return findErr
		}
		switch res.Status {
		case ReservationStatusReleased, ReservationStatusExpired:
			return nil // already released — idempotent no-op
		case ReservationStatusSold:
			return ErrReservationConflict
		}
		return nil // should not reach here
	}
	if err != nil {
		return fmt.Errorf("update reservation to RELEASED: %w", err)
	}

	// The reservation was successfully transitioned. Now decrement the ticket counter.
	ticketUpdate := bson.M{
		"$inc": bson.M{"reserved": -updated.Quantity, "version": 1},
		"$set": bson.M{"updatedAt": now},
	}
	if _, updErr := r.collection.UpdateOne(ctx, bson.M{"_id": updated.TicketID}, ticketUpdate); updErr != nil {
		return fmt.Errorf("decrement ticket reserved counter on release: %w", updErr)
	}

	// Restore the Redis availability counter after successful Mongo release.
	if r.quota != nil {
		_ = r.quota.Release(ctx, updated.TicketID, updated.UserID, updated.Quantity)
	}

	return nil
}

// FinalizeReservation transitions a RESERVED reservation to SOLD, sets orderId,
// and moves quantity from reserved to sold on the ticket. Uses atomic
// findOneAndUpdate on the reservation document (status filter: RESERVED→SOLD)
// to guard against concurrent finalization; no multi-document transaction is
// required. Idempotent for SOLD.
func (r *MongoTicketRepository) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	now := time.Now().UTC()

	// Atomically transition the reservation from RESERVED to SOLD.
	resvFilter := bson.M{"_id": reservationID, "status": ReservationStatusReserved}
	resvUpdate := bson.M{
		"$set": bson.M{
			"status":    ReservationStatusSold,
			"orderId":   orderID,
			"updatedAt": now,
		},
	}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var updated TicketReservation
	err := r.reservations.FindOneAndUpdate(ctx, resvFilter, resvUpdate, opts).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		// Either the reservation does not exist, or it is not in RESERVED state.
		res, findErr := r.FindReservationByID(ctx, reservationID)
		if errors.Is(findErr, ErrReservationNotFound) {
			return ErrReservationNotFound
		}
		if findErr != nil {
			return findErr
		}
		switch res.Status {
		case ReservationStatusSold:
			return nil // already finalized — idempotent no-op
		case ReservationStatusReleased, ReservationStatusExpired:
			return ErrReservationConflict
		}
		return nil // should not reach here
	}
	if err != nil {
		return fmt.Errorf("update reservation to SOLD: %w", err)
	}

	// Move quantity from reserved to sold on the ticket document.
	ticketUpdate := bson.M{
		"$inc": bson.M{"reserved": -updated.Quantity, "sold": updated.Quantity, "version": 1},
		"$set": bson.M{"updatedAt": now},
	}
	if _, updErr := r.collection.UpdateOne(ctx, bson.M{"_id": updated.TicketID}, ticketUpdate); updErr != nil {
		return fmt.Errorf("update ticket counters on finalize: %w", updErr)
	}

	// Clear the per-user reserved counter in Redis. Availability is NOT restored —
	// the quantity was permanently sold.
	if r.quota != nil {
		_ = r.quota.Finalize(ctx, updated.TicketID, updated.UserID, updated.Quantity)
	}

	return nil
}

// ─── Reconciliation helpers ────────────────────────────────────────────────────

// SweepExpiredReservations finds all reservations with status=RESERVED whose
// expiresAt is in the past, transitions each to RELEASED via ReleaseReservation
// (which also restores the ticket counter and Redis quota), and returns the
// count of reservations that were expired.
//
// This method is intended for use by the quota reconciliation worker. It is not
// part of the TicketRepository interface — callers take the concrete type.
func (r *MongoTicketRepository) SweepExpiredReservations(ctx context.Context) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	now := time.Now().UTC()
	filter := bson.M{
		"status":    ReservationStatusReserved,
		"expiresAt": bson.M{"$lt": now},
	}

	cursor, err := r.reservations.Find(ctx, filter)
	if err != nil {
		return 0, fmt.Errorf("sweep expired reservations: find: %w", err)
	}
	defer cursor.Close(ctx) //nolint:errcheck

	var expired []TicketReservation
	if err := cursor.All(ctx, &expired); err != nil {
		return 0, fmt.Errorf("sweep expired reservations: decode: %w", err)
	}

	count := 0
	for _, res := range expired {
		if releaseErr := r.ReleaseReservation(ctx, res.ID); releaseErr != nil {
			// Log-worthy but non-fatal: continue sweeping remaining reservations.
			// The reconciler will log this at its level.
			continue
		}
		count++
	}
	return count, nil
}

// ─── Seating plan attachment methods (CP-13) ──────────────────────────────────

// AttachSeatingPlan atomically sets seatingPlanId and ticketType on a ticket in a
// single MongoDB update. The caller must own the ticket. Returns ErrTicketNotFound
// if the ticket does not exist, ErrOwnership if the user doesn't own it, and
// ErrSeatingPlanAlreadyAttached if a plan is already set.
//
// Uses a conditional filter ($and) so the update is atomic: the seatingPlanId field
// must be absent or empty, ensuring two concurrent callers cannot both attach. Both
// seatingPlanId and ticketType are set in the same $set to avoid a separate Update call.
func (r *MongoTicketRepository) AttachSeatingPlan(ctx context.Context, ticketID, planID, userID, ticketType string, outbox *TicketOutboxEvent) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	now := time.Now().UTC()

	// Only match tickets owned by the caller AND without a seating plan attached.
	filter := bson.M{
		"_id":    ticketID,
		"userId": userID,
		"$or": bson.A{
			bson.M{"seatingPlanId": bson.M{"$exists": false}},
			bson.M{"seatingPlanId": ""},
		},
	}
	update := bson.M{
		"$set": bson.M{
			"seatingPlanId": planID,
			"ticket_type":   ticketType,
			"updatedAt":     now,
		},
		"$inc": bson.M{"version": 1},
	}
	if outbox != nil {
		update["$push"] = bson.M{"outbox": outbox}
	}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("attach seating plan to ticket %s: %w", ticketID, err)
	}
	if result.MatchedCount == 0 {
		// Distinguish the three failure cases by reading the current state.
		var t Ticket
		findErr := r.collection.FindOne(ctx, bson.M{"_id": ticketID}).Decode(&t)
		if errors.Is(findErr, mongo.ErrNoDocuments) {
			return ErrTicketNotFound
		}
		if findErr != nil {
			return fmt.Errorf("attach seating plan: lookup ticket: %w", findErr)
		}
		if t.UserID != userID {
			return ErrOwnership
		}
		// Ticket exists and is owned by caller — the filter failed because a plan is already set.
		return ErrSeatingPlanAlreadyAttached
	}
	return nil
}

// DetachSeatingPlan clears both seatingPlanId and ticketType from a ticket atomically.
// The caller must own the ticket. Idempotent: if no plan is attached the update is a no-op.
func (r *MongoTicketRepository) DetachSeatingPlan(ctx context.Context, ticketID, userID string, outbox *TicketOutboxEvent) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	now := time.Now().UTC()

	filter := bson.M{"_id": ticketID, "userId": userID}
	update := bson.M{
		// Clear both seatingPlanId and ticket_type in the same operation so the
		// document is never left in a state where ticketType implies seated but
		// no seatingPlanId exists.
		"$unset": bson.M{"seatingPlanId": "", "ticket_type": ""},
		"$set":   bson.M{"updatedAt": now},
		"$inc":   bson.M{"version": 1},
	}
	if outbox != nil {
		update["$push"] = bson.M{"outbox": outbox}
	}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("detach seating plan from ticket %s: %w", ticketID, err)
	}
	if result.MatchedCount == 0 {
		// Distinguish not-found from ownership failure.
		var t Ticket
		findErr := r.collection.FindOne(ctx, bson.M{"_id": ticketID}).Decode(&t)
		if errors.Is(findErr, mongo.ErrNoDocuments) {
			return ErrTicketNotFound
		}
		if findErr != nil {
			return fmt.Errorf("detach seating plan: lookup ticket: %w", findErr)
		}
		return ErrOwnership
	}
	return nil
}

// ClaimPendingOutboxEvents claims up to limit pending outbox events for relay.
// It uses a lease token on the embedded outbox item so multiple workers do not
// process the same event concurrently.
func (r *MongoTicketRepository) ClaimPendingOutboxEvents(ctx context.Context, leaseDuration time.Duration, limit int) ([]ClaimedOutboxEvent, error) {
	if limit <= 0 {
		limit = 1
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	now := time.Now().UTC()
	claimed := make([]ClaimedOutboxEvent, 0, limit)

	for len(claimed) < limit {
		claimToken := uuid.NewString()
		leaseUntil := now.Add(leaseDuration)

		filter := bson.M{
			"outbox": bson.M{"$elemMatch": bson.M{
				"nextAttemptAt": bson.M{"$lte": now},
				"$or": bson.A{
					bson.M{"claimToken": bson.M{"$exists": false}},
					bson.M{"leaseUntil": bson.M{"$lt": now}},
				},
			}},
		}
		update := bson.M{"$set": bson.M{
			"outbox.$.claimToken": claimToken,
			"outbox.$.leaseUntil": leaseUntil,
		}}

		var ticket Ticket
		err := r.collection.FindOneAndUpdate(
			ctx,
			filter,
			update,
			options.FindOneAndUpdate().SetReturnDocument(options.After),
		).Decode(&ticket)
		if errors.Is(err, mongo.ErrNoDocuments) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("claim outbox event: %w", err)
		}

		matched := false
		for _, event := range ticket.Outbox {
			if event.ClaimToken == claimToken {
				claimed = append(claimed, ClaimedOutboxEvent{TicketID: ticket.ID, Event: event})
				matched = true
				break
			}
		}
		if !matched {
			return nil, fmt.Errorf("claim outbox event: claim token %s not found", claimToken)
		}
	}

	return claimed, nil
}

// AcknowledgeOutboxEvent removes a delivered outbox event from the ticket document.
func (r *MongoTicketRepository) AcknowledgeOutboxEvent(ctx context.Context, ticketID, eventID, claimToken string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := bson.M{
		"_id": ticketID,
		"outbox": bson.M{"$elemMatch": bson.M{
			"id":         eventID,
			"claimToken": claimToken,
		}},
	}
	update := bson.M{"$pull": bson.M{"outbox": bson.M{"id": eventID}}}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("ack outbox event: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("ack outbox event: event %s not claimed", eventID)
	}
	return nil
}

// RequeueOutboxEvent clears a claim and schedules the event for a later retry.
func (r *MongoTicketRepository) RequeueOutboxEvent(ctx context.Context, ticketID, eventID, claimToken, lastErr string, attempts int, nextAttemptAt time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := bson.M{
		"_id": ticketID,
		"outbox": bson.M{"$elemMatch": bson.M{
			"id":         eventID,
			"claimToken": claimToken,
		}},
	}
	update := bson.M{
		"$set": bson.M{
			"outbox.$.attempts":      attempts,
			"outbox.$.lastError":     lastErr,
			"outbox.$.nextAttemptAt": nextAttemptAt,
		},
		"$unset": bson.M{
			"outbox.$.claimToken": "",
			"outbox.$.leaseUntil": "",
		},
	}

	result, err := r.collection.UpdateOne(ctx, filter, update)
	if err != nil {
		return fmt.Errorf("requeue outbox event: %w", err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("requeue outbox event: event %s not claimed", eventID)
	}
	return nil
}
