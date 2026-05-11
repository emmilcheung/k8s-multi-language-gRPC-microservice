package service

import (
	"context"
	"errors"
	"testing"
)

func TestEnsureOrganizerOwnsEvent_NilLookupIsForbidden(t *testing.T) {
	svc := NewAttendanceService(nil, nil, nil) // no ticketLookup wired
	err := svc.EnsureOrganizerOwnsEvent(context.Background(), "ticket-1", "user-1")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden when ticketLookup is nil, got %v", err)
	}
}

func TestEnsureOrganizerOwnsEvent_EmptyOrganizerIsForbidden(t *testing.T) {
	svc := NewAttendanceService(nil, nil, nil)
	err := svc.EnsureOrganizerOwnsEvent(context.Background(), "ticket-1", "")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden for empty organizer, got %v", err)
	}
}

func TestEnsureOrganizerOwnsEvent_OwnershipMismatchIsForbidden(t *testing.T) {
	svc := NewAttendanceServiceWithTicketLookup(nil, nil, nil, stubOwnerLookup{ownerID: "organizer-2"})
	err := svc.EnsureOrganizerOwnsEvent(context.Background(), "ticket-1", "organizer-1")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden for ownership mismatch, got %v", err)
	}
}

func TestEnsureOrganizerOwnsEvent_OwnershipMatchSucceeds(t *testing.T) {
	svc := NewAttendanceServiceWithTicketLookup(nil, nil, nil, stubOwnerLookup{ownerID: "organizer-1"})
	err := svc.EnsureOrganizerOwnsEvent(context.Background(), "ticket-1", "organizer-1")
	if err != nil {
		t.Fatalf("expected nil for matching ownership, got %v", err)
	}
}

// stubOwnerLookup is a test double for TicketOwnerLookup.
type stubOwnerLookup struct{ ownerID string }

func (s stubOwnerLookup) LookupTicketOwner(_ context.Context, _ string) (string, error) {
	return s.ownerID, nil
}
