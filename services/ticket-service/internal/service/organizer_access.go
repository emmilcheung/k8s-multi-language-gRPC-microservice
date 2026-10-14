package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/acme/ticket-service/internal/audit"
	"github.com/acme/ticket-service/internal/authz"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/security"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
)

// Permissions from the organizer permission table (which account role may do what) that ticket-service asks about.
const (
	permEventCreate = "event.create"
	permEventEdit   = "event.edit"
	permEventView   = "event.view"
)

// ErrActingAccountRequired is returned when enforcement is on and an organizer
// write names no organizer account.
var ErrActingAccountRequired = errors.New("choose an organizer account")

// ErrActingAccountInvalid is returned when the acting account is not an id.
var ErrActingAccountInvalid = errors.New("organizer account is not a valid id")

// ErrPermissionCheckFailed wraps a permission-service rejection that is not
// "unavailable" (for example a malformed request); it is a server fault.
var ErrPermissionCheckFailed = errors.New("permission check failed")

// Authorizer is the permission check organizer operations go through.
// *authz.Client implements it.
type Authorizer interface {
	Check(ctx context.Context, caller security.TrustedCaller, perm string, scope authz.Scope) (authz.Decision, error)
}

// AccountReads serves the organizer console's reads, which the buyer-facing
// repository interface has no need for.
type AccountReads interface {
	FindByAccount(ctx context.Context, accountID string, limit int, after string) ([]*repository.Ticket, error)
	ListAuditByResource(ctx context.Context, resource string, limit int, after string) ([]repository.AuditRecord, error)
}

var authzDisagreements = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "ticket_authz_disagreements_total",
	Help: "Logging-mode checks where the permission service and the old owner check gave different answers.",
}, []string{"permission", "old", "new"})

// WithAuthz sends organizer operations through the permission check. Without
// it (or in mode off) only the old creator comparison applies.
func (s *TicketService) WithAuthz(a Authorizer, mode authz.Mode) {
	s.authz = a
	s.authzMode = mode
}

// WithAccountReads enables eventsByAccount and eventHistory.
func (s *TicketService) WithAccountReads(r AccountReads) {
	s.accountReads = r
}

func (s *TicketService) enforcing() bool { return s.authz != nil && s.authzMode == authz.ModeOn }

func (s *TicketService) logging() bool { return s.authz != nil && s.authzMode == authz.ModeLog }

func normalizeActingAccount(id string) (string, error) {
	if id == "" {
		return "", nil
	}
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", ErrActingAccountInvalid
	}
	return parsed.String(), nil
}

// actingAccount reads the X-Organizer-Account selector. Only enforcement
// rejects a header that does not parse; otherwise it is treated as unset (and
// logged) so the old behaviour is unchanged.
func (s *TicketService) actingAccount(raw string) (string, error) {
	id, err := normalizeActingAccount(raw)
	if err != nil && !s.enforcing() {
		s.log.Warn("ignoring malformed organizer account header")
		return "", nil
	}
	return id, err
}

func withUser(c security.TrustedCaller, userID string) security.TrustedCaller {
	if c.UserID == "" {
		c.UserID = userID
	}
	return c
}

// decide answers one permission question. legacyAllowed is what the old owner
// rule says. Enforcing, the permission service decides and fails closed;
// logging, the old rule decides and any difference is recorded; otherwise the
// old rule decides. An empty scope account cannot be asked about, so it is
// decided by the old rule when not enforcing and refused when enforcing.
func (s *TicketService) decide(ctx context.Context, caller security.TrustedCaller, perm string, scope authz.Scope, legacyAllowed bool) (authz.Decision, error) {
	logged := authz.ReasonOff // what logging mode learned, for callers that care
	switch {
	case s.enforcing():
		if scope.AccountID == "" {
			return authz.Decision{Reason: authz.ReasonNotMember}, ErrUnauthorized
		}
		d, err := s.authz.Check(ctx, caller, perm, scope)
		if err != nil {
			if errors.Is(err, authz.ErrAuthzUnavailable) {
				return d, err
			}
			s.log.Error("authz rejected a ticket-service request", zap.String("permission", perm), zap.Error(err))
			return d, fmt.Errorf("%w: %v", ErrPermissionCheckFailed, err)
		}
		if !d.Allowed {
			return d, ErrUnauthorized
		}
		return d, nil
	case s.logging() && scope.AccountID != "":
		d, err := s.authz.Check(ctx, caller, perm, scope)
		if err == nil {
			logged = d.Reason
		}
		if err == nil && decided(d.Reason) {
			if newAllowed := d.Reason == authz.ReasonAllowed; newAllowed != legacyAllowed {
				authzDisagreements.WithLabelValues(perm, allowName(legacyAllowed), allowName(newAllowed)).Inc()
				s.log.Warn("authz disagrees with the owner check",
					zap.String("permission", perm), zap.String("userId", caller.UserID),
					zap.String("accountId", scope.AccountID), zap.Bool("ownerCheckAllowed", legacyAllowed),
					zap.String("authzReason", d.Reason))
			}
		}
	}
	if !legacyAllowed {
		return authz.Decision{}, ErrUnauthorized
	}
	return authz.Decision{Allowed: true, Reason: logged}, nil
}

// decided reports whether the reason is a real answer rather than "could not ask".
func decided(reason string) bool {
	switch reason {
	case authz.ReasonUnavailable, authz.ReasonUnknown, authz.ReasonOff:
		return false
	}
	return true
}

func allowName(b bool) string {
	if b {
		return "allow"
	}
	return "deny"
}

// authorizeCreate checks event.create on the acting account and returns the
// account that should own the new event: the verified acting account, or ""
// when nothing could be verified (logging without a header, or a caller who is
// not a member, so a forged header never claims someone else's account).
func (s *TicketService) authorizeCreate(ctx context.Context, caller security.TrustedCaller, acting string) (string, error) {
	if s.enforcing() && acting == "" {
		return "", ErrActingAccountRequired
	}
	d, err := s.decide(ctx, caller, permEventCreate, authz.Scope{AccountID: acting}, true)
	if err != nil {
		return "", err
	}
	if d.Reason == authz.ReasonAllowed || s.enforcing() {
		return acting, nil
	}
	return "", nil
}

// authorizeEdit checks event.edit against the event's own account. The acting
// account is only a selector: it must match the event's account, and the
// membership check runs on the event's account regardless of what was sent.
func (s *TicketService) authorizeEdit(ctx context.Context, caller security.TrustedCaller, acting string, ticket *repository.Ticket) error {
	legacy := ticket.UserID == caller.UserID
	if s.enforcing() && acting == "" {
		return ErrActingAccountRequired
	}
	scopeAccount := ticket.AccountID
	if scopeAccount == "" && !s.enforcing() {
		scopeAccount = acting
	}
	if s.enforcing() && acting != ticket.AccountID {
		return ErrUnauthorized
	}
	_, err := s.decide(ctx, caller, permEventEdit, authz.Scope{AccountID: scopeAccount}, legacy)
	return err
}

// EventsByAccount lists an organizer account's events, newest first. The
// caller needs event.view on the account. Pass limit+1 to detect a next page.
func (s *TicketService) EventsByAccount(ctx context.Context, caller security.TrustedCaller, accountID string, limit int, after string) ([]*repository.Ticket, error) {
	if caller.UserID == "" {
		return nil, ErrUnauthorized
	}
	if _, err := normalizeActingAccount(accountID); err != nil || accountID == "" {
		return nil, ErrActingAccountInvalid
	}
	if s.accountReads == nil {
		return nil, errors.New("events by account: not configured")
	}
	// The old rule never limited who could read the catalogue, so while not
	// enforcing, any signed-in caller may list; the check still runs and is compared.
	if _, err := s.decide(ctx, caller, permEventView, authz.Scope{AccountID: accountID}, true); err != nil {
		return nil, err
	}
	tickets, err := s.accountReads.FindByAccount(ctx, accountID, limit, after)
	if err != nil {
		return nil, fmt.Errorf("events by account: %w", err)
	}
	return tickets, nil
}

// EventHistory returns the audit entries of one event, newest first. The
// caller needs event.view on the event's account; while not enforcing, only
// the creator may read, as with edits. Pass limit+1 to detect a next page.
func (s *TicketService) EventHistory(ctx context.Context, caller security.TrustedCaller, eventID string, limit int, after string) ([]repository.AuditRecord, error) {
	if caller.UserID == "" {
		return nil, ErrUnauthorized
	}
	if s.accountReads == nil {
		return nil, errors.New("event history: not configured")
	}
	ticket, err := s.repo.FindByID(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("event history: %w", err)
	}
	if _, err := s.decide(ctx, caller, permEventView, authz.Scope{AccountID: ticket.AccountID}, ticket.UserID == caller.UserID); err != nil {
		return nil, err
	}
	rows, err := s.accountReads.ListAuditByResource(ctx, auditResource(eventID), limit, after)
	if err != nil {
		return nil, fmt.Errorf("event history: %w", err)
	}
	return rows, nil
}

func auditResource(ticketID string) string { return "ticket:" + ticketID }

func traceID(ctx context.Context) string {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		return sc.TraceID().String()
	}
	return ""
}

func eventAuditFields(e *repository.TicketEvent) map[string]any {
	if e == nil {
		return nil
	}
	out := map[string]any{"title": e.Title, "description": e.Description, "startsAt": e.StartsAt, "imageUrl": e.ImageURL,
		"venueName": e.VenueName, "venueAddress": e.VenueAddress}
	if e.EndsAt != nil {
		out["endsAt"] = *e.EndsAt
	}
	return out
}

// editAudit describes an edit with only the fields that changed. before and
// after are the ticket as loaded and as changed.
func editAudit(ctx context.Context, actorUserID, actorAccountID string, before, after repository.Ticket) audit.Entry {
	b, a := map[string]any{}, map[string]any{}
	if before.Title != after.Title {
		b["title"], a["title"] = before.Title, after.Title
	}
	if before.Price != after.Price {
		b["price"], a["price"] = before.Price, after.Price
	}
	if before.SeatingPlanID != after.SeatingPlanID {
		b["seatingPlanId"], a["seatingPlanId"] = before.SeatingPlanID, after.SeatingPlanID
	}
	if !reflect.DeepEqual(before.Event, after.Event) {
		b["event"], a["event"] = eventAuditFields(before.Event), eventAuditFields(after.Event)
	}
	return audit.Entry{
		ActorUserID: actorUserID, ActorAccountID: actorAccountID,
		Action: permEventEdit, Resource: auditResource(after.ID),
		Before: b, After: a, TraceID: traceID(ctx),
	}
}
