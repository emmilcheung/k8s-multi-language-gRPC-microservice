// Package repository defines the domain types and repository interfaces for venue-service.
package repository

import (
	"context"
	"errors"
	"time"
)

// ── Sentinel errors ───────────────────────────────────────────────────────────

var (
	ErrVenueNotFound       = errors.New("venue not found")
	ErrPlanNotFound        = errors.New("seating plan not found")
	ErrSectionNotFound     = errors.New("section not found")
	ErrSeatNotFound        = errors.New("seat not found")
	ErrReservationNotFound = errors.New("seat reservation not found")

	ErrPlanAlreadyActive      = errors.New("seating plan is already active")
	ErrPlanNotAttached        = errors.New("seating plan is not attached to a ticket")
	ErrPlanHasNoSections      = errors.New("seating plan has no purchasable sections")
	ErrSeatNotAvailable       = errors.New("one or more seats are not available")
	ErrSeatNotHeldByUser      = errors.New("seat is not held by the requesting user")
	ErrReservationConflict    = errors.New("reservation is in a terminal state (SOLD) and cannot be modified")
	ErrReservationAlreadyDone = errors.New("reservation is already in the requested state (idempotent)")
	ErrVersionConflict        = errors.New("optimistic concurrency conflict: version mismatch")
)

// ── Enumerations ──────────────────────────────────────────────────────────────

type PlanStatus string

const (
	PlanStatusDraft  PlanStatus = "draft"
	PlanStatusActive PlanStatus = "active"
	PlanStatusClosed PlanStatus = "closed"
)

type SeatStatus string

const (
	SeatStatusAvailable SeatStatus = "AVAILABLE"
	SeatStatusHeld      SeatStatus = "HELD"
	SeatStatusReserved  SeatStatus = "RESERVED"
	SeatStatusSold      SeatStatus = "SOLD"
	SeatStatusBlocked   SeatStatus = "BLOCKED"
)

type ReservationStatus string

const (
	ReservationStatusReserved ReservationStatus = "RESERVED"
	ReservationStatusReleased ReservationStatus = "RELEASED"
	ReservationStatusSold     ReservationStatus = "SOLD"
	ReservationStatusExpired  ReservationStatus = "EXPIRED"
)

type SectionType string

const (
	SectionTypeSeated SectionType = "seated"
	SectionTypeGA     SectionType = "ga"
)

// ── Domain types ──────────────────────────────────────────────────────────────

// Venue represents a physical or virtual event location.
type Venue struct {
	ID          string    `db:"id"          json:"id"`
	OrganizerID string    `db:"organizer_id" json:"organizerId"`
	Name        string    `db:"name"         json:"name"`
	Capacity    int       `db:"capacity"     json:"capacity"`
	Timezone    string    `db:"timezone"     json:"timezone"`
	CreatedAt   time.Time `db:"created_at"   json:"createdAt"`
	UpdatedAt   time.Time `db:"updated_at"   json:"updatedAt"`
}

// SeatingPlan links a set of sections to a specific ticket.
// ticket_id is nullable during draft creation and required before activation.
type SeatingPlan struct {
	ID               string     `db:"id"          json:"id"`
	VenueID          string     `db:"venue_id"    json:"venueId"`
	TicketID         string     `db:"ticket_id"   json:"ticketId"` // empty until attached
	OrganizerID      string     `db:"organizer_id" json:"organizerId"`
	Name             string     `db:"name"         json:"name"`
	Status           PlanStatus `db:"status"       json:"status"`
	HoldTTLSec       int        `db:"hold_ttl_sec" json:"holdTtlSec"`
	MaxSeatsPerOrder int        `db:"max_seats_per_order" json:"maxSeatsPerOrder"`
	Version          int        `db:"version"      json:"version"`
	CreatedAt        time.Time  `db:"created_at"   json:"createdAt"`
	UpdatedAt        time.Time  `db:"updated_at"   json:"updatedAt"`
}

// Section is a named group of seats inside a seating plan.
type Section struct {
	ID          string      `db:"id"           json:"id"`
	PlanID      string      `db:"plan_id"      json:"planId"`
	Name        string      `db:"name"         json:"name"`
	Type        SectionType `db:"type"         json:"type"`
	RowCount    int         `db:"row_count"    json:"rowCount"`
	ColumnCount int         `db:"column_count" json:"columnCount"`
	CreatedAt   time.Time   `db:"created_at"   json:"createdAt"`
	UpdatedAt   time.Time   `db:"updated_at"   json:"updatedAt"`
}

// PriceTier defines a named price level within a seating plan.
type PriceTier struct {
	ID        string    `db:"id"         json:"id"`
	PlanID    string    `db:"plan_id"    json:"planId"`
	Name      string    `db:"name"       json:"name"`
	Price     string    `db:"price"      json:"price"` // decimal string (e.g. "75.00")
	CreatedAt time.Time `db:"created_at" json:"createdAt"`
}

// Seat is a single bookable seat inside a section.
type Seat struct {
	ID           string     `db:"id"                  json:"id"`
	SectionID    string     `db:"section_id"          json:"sectionId"`
	PlanID       string     `db:"plan_id"             json:"planId"`
	PriceTierID  string     `db:"price_tier_id"       json:"priceTierId"`
	SeatLabel    string     `db:"seat_label"          json:"seatLabel"`
	RowLabel     string     `db:"row_label"           json:"rowLabel"`
	ColumnNumber int        `db:"column_number"       json:"columnNumber"`
	Status       SeatStatus `db:"status"              json:"status"`
	HeldBy       string     `db:"held_by"             json:"heldBy,omitempty"`
	HeldUntil    *time.Time `db:"held_until"          json:"heldUntil,omitempty"`
	Attributes   string     `db:"attributes"          json:"attributes"` // JSON blob
	Version      int        `db:"version"             json:"version"`
	CreatedAt    time.Time  `db:"created_at"          json:"createdAt"`
	UpdatedAt    time.Time  `db:"updated_at"          json:"updatedAt"`
}

// SeatReservation is the durable reservation ledger entry for a group of seats.
// This is the source of truth for idempotent operations.
type SeatReservation struct {
	ID        string                `db:"id"          json:"id"`
	PlanID    string                `db:"plan_id"     json:"planId"`
	TicketID  string                `db:"ticket_id"   json:"ticketId"`
	OrderID   string                `db:"order_id"    json:"orderId,omitempty"` // set after order creation
	UserID    string                `db:"user_id"     json:"userId"`
	SectionID string                `db:"section_id"  json:"sectionId,omitempty"`
	Status    ReservationStatus     `db:"status"      json:"status"`
	ExpiresAt *time.Time            `db:"expires_at"  json:"expiresAt,omitempty"`
	CreatedAt time.Time             `db:"created_at"  json:"createdAt"`
	UpdatedAt time.Time             `db:"updated_at"  json:"updatedAt"`
	Items     []SeatReservationItem `db:"-"       json:"items,omitempty"`
}

// SeatReservationItem is one seat row within a SeatReservation.
type SeatReservationItem struct {
	ReservationID string `db:"reservation_id" json:"reservationId"`
	SeatID        string `db:"seat_id"        json:"seatId"`
	SectionID     string `db:"section_id"     json:"sectionId"`
	Price         string `db:"price"          json:"price"` // snapshot at reservation time
	SeatLabel     string `db:"seat_label"     json:"seatLabel"`
}

// ── Repository interfaces ─────────────────────────────────────────────────────

// VenueRepository manages venue CRUD.
type VenueRepository interface {
	Create(ctx context.Context, v *Venue) error
	FindByID(ctx context.Context, id string) (*Venue, error)
	ListByOrganizer(ctx context.Context, organizerID string) ([]*Venue, error)
	Update(ctx context.Context, v *Venue) error
	Ping(ctx context.Context) error
}

// PlanRepository manages seating plan CRUD and lifecycle transitions.
type PlanRepository interface {
	Create(ctx context.Context, p *SeatingPlan) error
	FindByID(ctx context.Context, id string) (*SeatingPlan, error)
	ListByTicket(ctx context.Context, ticketID string) ([]*SeatingPlan, error)
	AttachTicket(ctx context.Context, planID, ticketID string, expectedVersion int) error
	Activate(ctx context.Context, planID string, expectedVersion int) error
	Update(ctx context.Context, p *SeatingPlan) error
}

// SectionRepository manages section and seat CRUD inside a plan.
type SectionRepository interface {
	CreateSection(ctx context.Context, s *Section) error
	FindSectionByID(ctx context.Context, id string) (*Section, error)
	ListSectionsByPlan(ctx context.Context, planID string) ([]*Section, error)
	UpsertSeat(ctx context.Context, seat *Seat) error
	FindSeatsBySection(ctx context.Context, sectionID string) ([]*Seat, error)
	FindSeatsByIDs(ctx context.Context, seatIDs []string) ([]*Seat, error)
	GetAvailableSeatsInSection(ctx context.Context, sectionID string) ([]*Seat, error)

	// HoldSeats atomically transitions seats AVAILABLE → HELD for the given user.
	// Fails with ErrSeatNotAvailable if any seat is not AVAILABLE.
	HoldSeats(ctx context.Context, seatIDs []string, userID string, expiresAt time.Time) error

	// ReleaseHold releases any HELD seats back to AVAILABLE if held by userID.
	ReleaseHold(ctx context.Context, seatIDs []string, userID string) error

	// ReserveSeats atomically transitions HELD/AVAILABLE seats → RESERVED within a transaction.
	// Returns ErrSeatNotAvailable if any seat cannot be reserved.
	ReserveSeats(ctx context.Context, seatIDs []string, reservationID string) error

	// ReleaseReservedSeats transitions RESERVED seats → AVAILABLE.
	ReleaseReservedSeats(ctx context.Context, seatIDs []string) error

	// SellSeats transitions RESERVED seats → SOLD (terminal).
	SellSeats(ctx context.Context, seatIDs []string) error
}

// ReservationRepository manages the durable seat reservation ledger.
type ReservationRepository interface {
	// CreateReservation writes the reservation + items atomically.
	// The caller is responsible for ensuring seats are already RESERVED.
	CreateReservation(ctx context.Context, r *SeatReservation) error

	FindReservationByID(ctx context.Context, id string) (*SeatReservation, error)

	// ReleaseReservation transitions RESERVED → RELEASED and restores seats to AVAILABLE.
	// Idempotent: RELEASED reservations return success.
	// Returns ErrReservationConflict if already SOLD.
	ReleaseReservation(ctx context.Context, reservationID, reason string) error

	// FinalizeReservation transitions RESERVED → SOLD and records the orderId.
	// Idempotent: SOLD reservations return success.
	// Returns ErrReservationConflict if RELEASED.
	FinalizeReservation(ctx context.Context, reservationID, orderID string) error
}
