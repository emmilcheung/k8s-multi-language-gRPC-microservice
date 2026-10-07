package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/acme/venue-service/internal/audit"
	"github.com/acme/venue-service/internal/authz"
	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Permissions from the docs/19 table that venue-service asks about.
const (
	permVenueCreate      = "venue.create"
	permVenueEditProfile = "venue.edit_profile"
	permLayoutCreate     = "layout.create"
	permEventEdit        = "event.edit"
)

// Audit actions.
const (
	ActionVenueCreate        = "venue.create"
	ActionVenueUpdate        = "venue.update"
	ActionVenueSectionCreate = "venue_section.create"
	ActionVenueSectionUpdate = "venue_section.update"
	ActionVenueSectionDelete = "venue_section.delete"
	ActionPlanCreate         = "seating_plan.create"
	ActionPlanUpdate         = "seating_plan.update"
	ActionPlanActivate       = "seating_plan.activate"
	ActionPlanDeactivate     = "seating_plan.deactivate"
	ActionPlanSaveLayout     = "seating_plan.save_layout"
	ActionSectionCreate      = "seating_plan.section_create"
	ActionPriceTierCreate    = "seating_plan.price_tier_create"
)

var (
	// ErrUnauthorized means the caller may not make this change.
	ErrUnauthorized = errors.New("not allowed to change this resource")
	// ErrActingAccountRequired is returned when enforcement is on and an organizer
	// write names no organizer account.
	ErrActingAccountRequired = errors.New("choose an organizer account")
	// ErrActingAccountInvalid is returned when the acting account is not an id.
	ErrActingAccountInvalid = errors.New("organizer account is not a valid id")
	// ErrPermissionCheckFailed wraps a permission-service rejection that is not
	// "unavailable" (for example a malformed request); it is a server fault.
	ErrPermissionCheckFailed = errors.New("permission check failed")
	// ErrTicketNotFound means the ticket a plan is for does not exist.
	ErrTicketNotFound = errors.New("ticket not found")
	// ErrTicketLookupUnavailable means ticket-service could not say who owns a ticket.
	ErrTicketLookupUnavailable = errors.New("ticket owner lookup unavailable")
)

// Authorizer is the permission check organizer operations go through.
// *authz.Client implements it.
type Authorizer interface {
	Check(ctx context.Context, caller security.TrustedCaller, perm string, scope authz.Scope) (authz.Decision, error)
}

// TicketLookup is the part of ticket-service's client needed to learn which
// account owns a ticket.
type TicketLookup interface {
	GetTicket(ctx context.Context, in *ticketsv1.GetTicketRequest, opts ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error)
}

// TxRunner runs a function inside one database transaction.
type TxRunner interface {
	InTx(ctx context.Context, fn func(ctx context.Context, tx pgx.Tx) error) error
}

var authzDisagreements = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "venue_authz_disagreements_total",
	Help: "Logging-mode checks where the permission service and the old owner check gave different answers.",
}, []string{"permission", "old", "new"})

// OrganizerAccess decides who may change venues, venue sections and seating
// plans, and records each change in the audit history. Buyer paths (holds,
// reserves, reads) never come here.
type OrganizerAccess struct {
	authz   Authorizer
	mode    authz.Mode
	tickets TicketLookup
	tx      TxRunner
	record  func(ctx context.Context, tx pgx.Tx, e audit.Entry) error
	log     *zap.Logger
}

// NewOrganizerAccess wires the checks. With mode off (or a nil authorizer) the
// old creator comparison alone decides and nothing is audited.
func NewOrganizerAccess(a Authorizer, mode authz.Mode, tickets TicketLookup, tx TxRunner, log *zap.Logger) *OrganizerAccess {
	return &OrganizerAccess{authz: a, mode: mode, tickets: tickets, tx: tx, record: audit.Record, log: log}
}

// Enforcing reports whether the permission service decides.
func (a *OrganizerAccess) Enforcing() bool { return a.authz != nil && a.mode == authz.ModeOn }

func (a *OrganizerAccess) logging() bool { return a.authz != nil && a.mode == authz.ModeLog }

func (a *OrganizerAccess) auditing() bool {
	return a.authz != nil && a.mode != authz.ModeOff && a.tx != nil
}

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

// ActingAccount reads the X-Organizer-Account selector. Only enforcement
// rejects a header that does not parse; otherwise it is treated as unset (and
// logged) so the old behaviour is unchanged.
func (a *OrganizerAccess) ActingAccount(raw string) (string, error) {
	id, err := normalizeActingAccount(raw)
	if err != nil && !a.Enforcing() {
		a.log.Warn("ignoring malformed organizer account header")
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

func scopeEmpty(s authz.Scope) bool { return s.AccountID == "" && s.VenueID == "" && s.EventID == "" }

// decide answers one permission question. legacyAllowed is what the old owner
// rule says. Enforcing, the permission service decides and fails closed;
// logging, the old rule decides and any difference is recorded; otherwise the
// old rule decides.
func (a *OrganizerAccess) decide(ctx context.Context, caller security.TrustedCaller, perm string, scope authz.Scope, legacyAllowed bool) (authz.Decision, error) {
	logged := authz.ReasonOff
	switch {
	case a.Enforcing():
		if scopeEmpty(scope) {
			return authz.Decision{Reason: authz.ReasonNotMember}, ErrUnauthorized
		}
		d, err := a.authz.Check(ctx, caller, perm, scope)
		if err != nil {
			if errors.Is(err, authz.ErrAuthzUnavailable) {
				return d, err
			}
			a.log.Error("authz rejected a venue-service request", zap.String("permission", perm), zap.Error(err))
			return d, fmt.Errorf("%w: %v", ErrPermissionCheckFailed, err)
		}
		if !d.Allowed {
			return d, ErrUnauthorized
		}
		return d, nil
	case a.logging() && !scopeEmpty(scope):
		d, err := a.authz.Check(ctx, caller, perm, scope)
		if err == nil {
			logged = d.Reason
		}
		if err == nil && decided(d.Reason) {
			if newAllowed := d.Reason == authz.ReasonAllowed; newAllowed != legacyAllowed {
				a.disagree(caller, perm, scope, legacyAllowed, newAllowed, d.Reason)
			}
		}
	}
	if !legacyAllowed {
		return authz.Decision{}, ErrUnauthorized
	}
	return authz.Decision{Allowed: true, Reason: logged}, nil
}

func (a *OrganizerAccess) disagree(caller security.TrustedCaller, perm string, scope authz.Scope, old, new bool, reason string) {
	authzDisagreements.WithLabelValues(perm, allowName(old), allowName(new)).Inc()
	a.log.Warn("authz disagrees with the owner check",
		zap.String("permission", perm), zap.String("userId", caller.UserID),
		zap.String("accountId", scope.AccountID), zap.String("venueId", scope.VenueID),
		zap.Bool("ownerCheckAllowed", old), zap.String("authzReason", reason))
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

// AuthorizeVenueCreate checks venue.create on the acting account and returns
// the account the new venue should record as its creator: the verified acting
// account, or "" when nothing could be verified (logging without a header, or a
// caller who is not a member), so a forged header never claims an account.
func (a *OrganizerAccess) AuthorizeVenueCreate(ctx context.Context, caller security.TrustedCaller, acting string) (string, error) {
	if a.Enforcing() && acting == "" {
		return "", ErrActingAccountRequired
	}
	d, err := a.decide(ctx, caller, permVenueCreate, authz.Scope{AccountID: acting}, true)
	if err != nil {
		return "", err
	}
	if d.Reason == authz.ReasonAllowed || a.Enforcing() {
		return acting, nil
	}
	return "", nil
}

// AuthorizeVenueEdit checks who may change a venue's profile or its template
// sections. An unverified venue belongs to the account that created it
// (venue.create on that account); a verified one to its venue team
// (venue.edit_profile on the venue). Platform staff are admitted by the
// permission service itself. The acting account is only a selector: what is
// checked comes from the stored venue. The returned account is the one the
// check vouches for ("" when none).
func (a *OrganizerAccess) AuthorizeVenueEdit(ctx context.Context, caller security.TrustedCaller, acting string, venue *repository.Venue) (string, error) {
	legacy := venue.OrganizerID == caller.UserID
	if venue.Status == repository.VenueStatusVerified {
		_, err := a.decide(ctx, caller, permVenueEditProfile, authz.Scope{VenueID: venue.ID}, legacy)
		return "", err
	}
	staff := len(caller.PlatformRoles) > 0
	if a.Enforcing() && acting == "" && !staff {
		return "", ErrActingAccountRequired
	}
	if a.Enforcing() && !staff && acting != venue.CreatedByAccountID {
		return "", ErrUnauthorized
	}
	scopeAccount := venue.CreatedByAccountID
	if scopeAccount == "" && (staff || !a.Enforcing()) {
		scopeAccount = acting
	}
	d, err := a.decide(ctx, caller, permVenueCreate, authz.Scope{AccountID: scopeAccount}, legacy)
	if err != nil {
		return "", err
	}
	if scopeAccount != "" && (a.Enforcing() || d.Reason == authz.ReasonAllowed) && scopeAccount == acting {
		return acting, nil
	}
	return "", nil
}

// ticketAccount asks ticket-service which account owns the ticket.
func (a *OrganizerAccess) ticketAccount(ctx context.Context, ticketID string) (string, error) {
	if a.tickets == nil || ticketID == "" {
		return "", ErrTicketNotFound
	}
	resp, err := a.tickets.GetTicket(ctx, &ticketsv1.GetTicketRequest{TicketId: ticketID})
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return "", ErrTicketNotFound
		}
		return "", fmt.Errorf("%w: %v", ErrTicketLookupUnavailable, err)
	}
	return resp.GetAccountId(), nil
}

// venueUsable says whether an account may put a seating plan at the venue: any
// verified venue, or an unverified one the account created.
func venueUsable(v *repository.Venue, account string) bool {
	return v.Status == repository.VenueStatusVerified || (account != "" && v.CreatedByAccountID == account)
}

// AuthorizePlanCreate checks that the caller's account may edit the ticket the
// plan is for and may use the venue, and that it may create layouts. Without
// enforcement the old behaviour (no check) stands and the comparison is only
// logged. The returned account is the one the check vouches for.
func (a *OrganizerAccess) AuthorizePlanCreate(ctx context.Context, caller security.TrustedCaller, acting string, venue *repository.Venue, ticketID string) (string, error) {
	if a.Enforcing() {
		if acting == "" {
			return "", ErrActingAccountRequired
		}
		owner, err := a.ticketAccount(ctx, ticketID)
		if err != nil {
			return "", err
		}
		if owner != acting || !venueUsable(venue, acting) {
			return "", ErrUnauthorized
		}
		if _, err := a.decide(ctx, caller, permLayoutCreate, authz.Scope{AccountID: acting}, true); err != nil {
			return "", err
		}
		if _, err := a.decide(ctx, caller, permEventEdit, authz.Scope{AccountID: acting}, true); err != nil {
			return "", err
		}
		return acting, nil
	}
	if !a.logging() || acting == "" {
		return "", nil
	}
	vouched := true
	if owner, err := a.ticketAccount(ctx, ticketID); err == nil && (owner != acting || !venueUsable(venue, acting)) {
		a.disagree(caller, permLayoutCreate, authz.Scope{AccountID: acting}, true, false, "ticket_or_venue_not_usable")
		vouched = false
	}
	for _, perm := range []string{permLayoutCreate, permEventEdit} {
		d, _ := a.decide(ctx, caller, perm, authz.Scope{AccountID: acting}, true)
		vouched = vouched && d.Reason == authz.ReasonAllowed
	}
	if vouched {
		return acting, nil
	}
	return "", nil
}

// AuthorizePlanEdit checks that the caller's account owns the plan's ticket and
// may create layouts. The plan's account is the account of its ticket.
func (a *OrganizerAccess) AuthorizePlanEdit(ctx context.Context, caller security.TrustedCaller, acting string, plan *repository.SeatingPlan) (string, error) {
	legacy := plan.OrganizerID == caller.UserID
	if a.Enforcing() {
		if acting == "" {
			return "", ErrActingAccountRequired
		}
		owner, err := a.ticketAccount(ctx, plan.TicketID)
		if err != nil {
			if errors.Is(err, ErrTicketNotFound) {
				return "", ErrUnauthorized
			}
			return "", err
		}
		if owner != acting {
			return "", ErrUnauthorized
		}
		if _, err := a.decide(ctx, caller, permLayoutCreate, authz.Scope{AccountID: acting}, legacy); err != nil {
			return "", err
		}
		return acting, nil
	}
	if !a.logging() || acting == "" {
		_, err := a.decide(ctx, caller, permLayoutCreate, authz.Scope{}, legacy)
		return "", err
	}
	vouched := true
	if owner, err := a.ticketAccount(ctx, plan.TicketID); err == nil && owner != acting {
		a.disagree(caller, permLayoutCreate, authz.Scope{AccountID: acting}, legacy, false, "ticket_owned_by_another_account")
		vouched = false
	}
	d, err := a.decide(ctx, caller, permLayoutCreate, authz.Scope{AccountID: acting}, legacy)
	if err != nil {
		return "", err
	}
	if vouched && d.Reason == authz.ReasonAllowed {
		return acting, nil
	}
	return "", nil
}

// Audited runs change and writes the audit entry in the same transaction, so
// the two commit or roll back together. build runs after change so it can name
// ids the change created. Without auditing (mode off) it just runs change.
func (a *OrganizerAccess) Audited(ctx context.Context, build func() audit.Entry, change func(ctx context.Context) error) error {
	if !a.auditing() {
		return change(ctx)
	}
	return a.tx.InTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		if err := change(ctx); err != nil {
			return err
		}
		return a.record(ctx, tx, build())
	})
}

// TraceID returns the current trace id for the audit entry, or "".
func TraceID(ctx context.Context) string {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		return sc.TraceID().String()
	}
	return ""
}

// WithCallerUser fills in the user id when the verified caller has none.
func WithCallerUser(c security.TrustedCaller, userID string) security.TrustedCaller {
	return withUser(c, userID)
}

// ChangeEntry describes a change with only the fields whose values differ
// between before and after (a nil before means every field of after is new).
func ChangeEntry(ctx context.Context, actorUserID, actorAccountID, action, resource string, before, after map[string]any) audit.Entry {
	b, a := map[string]any{}, map[string]any{}
	for k, av := range after {
		bv, had := before[k]
		if had && reflect.DeepEqual(bv, av) {
			continue
		}
		a[k] = av
		if had {
			b[k] = bv
		}
	}
	for k, bv := range before {
		if _, ok := after[k]; !ok {
			b[k] = bv
		}
	}
	if len(b) == 0 {
		b = nil
	}
	return audit.Entry{
		ActorUserID: actorUserID, ActorAccountID: actorAccountID,
		Action: action, Resource: resource,
		Before: b, After: a, TraceID: TraceID(ctx),
	}
}

// VenueFields and PlanFields are the editable fields recorded in audit history.
func VenueFields(v *repository.Venue) map[string]any {
	return map[string]any{"name": v.Name, "capacity": v.Capacity, "timezone": v.Timezone, "address": v.Address}
}

// PlanFields lists the editable plan fields recorded in audit history.
func PlanFields(p *repository.SeatingPlan) map[string]any {
	return map[string]any{
		"name": p.Name, "maxSeatsPerOrder": p.MaxSeatsPerOrder,
		"assignmentMode": p.AssignmentMode, "pricingMode": p.PricingMode, "status": p.Status,
	}
}

// Checking reports whether organizer checks consult the permission service at
// all (logging or enforcing), so callers can skip extra lookups when off.
func (a *OrganizerAccess) Checking() bool { return a.Enforcing() || a.logging() }
