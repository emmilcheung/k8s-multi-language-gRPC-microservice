package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"time"

	"github.com/acme/attendance-service/internal/audit"
	"github.com/acme/attendance-service/internal/authz"
	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
)

// Permissions from the docs/19 table that attendance-service asks about.
const (
	PermAttendanceScan = "attendance.scan"
	PermEventEdit      = "event.edit"
	PermEventView      = "event.view"
)

// ActionPolicyUpdate is the audit action for an attendance policy change.
const ActionPolicyUpdate = "attendance.policy_update"

var (
	// ErrActingAccountRequired is returned when enforcement is on and an
	// organizer request names no organizer account.
	ErrActingAccountRequired = errors.New("choose an organizer account")
	// ErrActingAccountInvalid is returned when the acting account is not an id.
	ErrActingAccountInvalid = errors.New("organizer account is not a valid id")
	// ErrPermissionCheckFailed wraps a permission-service rejection that is not
	// "unavailable" (for example a malformed request); it is a server fault.
	ErrPermissionCheckFailed = errors.New("permission check failed")
	// ErrTicketLookupUnavailable means ticket-service could not say which
	// account owns the event while enforcement needed the answer.
	ErrTicketLookupUnavailable = errors.New("ticket owner lookup unavailable")
	// ErrScanTokenUnverifiable means enforcement could not trust the event a
	// scan token names (bad signature or malformed), so the scanner cannot be
	// scoped. The caller answers like an invalid signature and records nothing.
	ErrScanTokenUnverifiable = errors.New("scan token cannot be verified")
)

// Authorizer is the permission check organizer and staff operations go through.
// *authz.Client implements it.
type Authorizer interface {
	Check(ctx context.Context, caller security.TrustedCaller, perm string, scope authz.Scope) (authz.Decision, error)
}

// TicketOwner says who created a ticket and which organizer account owns it.
type TicketOwner struct {
	UserID    string
	AccountID string
}

// TicketOwnershipLookup resolves a ticket's creator and owning account.
type TicketOwnershipLookup interface {
	LookupTicketOwnership(ctx context.Context, ticketID string) (TicketOwner, error)
}

// TokenVerifier reads the event out of a signed admission token. VerifySigned
// returns the claims whenever the signature is good, expired or not.
type TokenVerifier interface {
	VerifySigned(token string) (*qr.Claims, error)
}

// TxRunner runs a function inside one database transaction.
type TxRunner interface {
	InTx(ctx context.Context, fn func(ctx context.Context, tx pgx.Tx) error) error
}

var authzDisagreements = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "attendance_authz_disagreements_total",
	Help: "Logging-mode checks where the permission service and the old owner check gave different answers.",
}, []string{"permission", "old", "new"})

// OrganizerAccess decides who may scan, read and change the attendance policy
// of an event. Buyer paths (own passes, transfers) never come here.
type OrganizerAccess struct {
	authz    Authorizer
	mode     authz.Mode
	tickets  TicketOwnershipLookup
	tokens   TokenVerifier
	tx       TxRunner
	verifier *security.CallerVerifier
	record   func(ctx context.Context, tx pgx.Tx, e audit.Entry) error
	log      *zap.Logger
}

// NewOrganizerAccess wires the checks. With mode off (or a nil authorizer) the
// old creator comparison alone decides and nothing is audited. verifier may be
// nil, which trusts the user id the caller already verified and no roles.
func NewOrganizerAccess(a Authorizer, mode authz.Mode, tickets TicketOwnershipLookup, tokens TokenVerifier, tx TxRunner, verifier *security.CallerVerifier, log *zap.Logger) *OrganizerAccess {
	return &OrganizerAccess{authz: a, mode: mode, tickets: tickets, tokens: tokens, tx: tx, verifier: verifier, record: audit.Record, log: log}
}

// Enforcing reports whether the permission service decides.
func (a *OrganizerAccess) Enforcing() bool { return a.authz != nil && a.mode == authz.ModeOn }

func (a *OrganizerAccess) logging() bool { return a.authz != nil && a.mode == authz.ModeLog }

func (a *OrganizerAccess) auditing() bool {
	return a.authz != nil && a.mode != authz.ModeOff && a.tx != nil
}

// ActingAccount reads the X-Organizer-Account selector. Only enforcement
// rejects a header that does not parse; otherwise it is treated as unset (and
// logged) so the old behaviour is unchanged.
func (a *OrganizerAccess) ActingAccount(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	parsed, err := uuid.Parse(raw)
	if err != nil {
		if a.Enforcing() {
			return "", ErrActingAccountInvalid
		}
		a.log.Warn("ignoring malformed organizer account header")
		return "", nil
	}
	return parsed.String(), nil
}

// Caller returns the verified caller and the organizer account they selected
// with X-Organizer-Account. userID has already passed the signature check.
func (a *OrganizerAccess) Caller(h http.Header, userID string) (security.TrustedCaller, string, error) {
	caller := security.TrustedCaller{UserID: userID}
	if a.verifier != nil {
		caller = a.verifier.TrustedCaller(userID, h.Get("X-User-Id-Sig"), h.Get("X-User-Roles"), h.Get("X-User-Roles-Sig"))
		if caller.UserID == "" {
			caller.UserID = userID
		}
	}
	acting, err := a.ActingAccount(h.Get("X-Organizer-Account"))
	return caller, acting, err
}

// AuthorizeEvent checks that the caller may exercise perm on the event (which
// is the ticket id). The event's account and creator come from the ticket
// lookup, never from the request: the acting account is only a selector and
// must match. ownerOnly says whether the old rule was "creator only"; when
// false the old rule allowed everyone, so outside enforcement the check is
// only compared and logged. The returned account is the one the check vouches
// for ("" when none could be verified).
func (a *OrganizerAccess) AuthorizeEvent(ctx context.Context, caller security.TrustedCaller, acting, perm, eventID string, ownerOnly bool) (string, error) {
	enforcing := a.Enforcing()
	if !ownerOnly && !enforcing && !a.logging() {
		return "", nil
	}
	if (ownerOnly || enforcing) && caller.UserID == "" {
		return "", ErrForbidden
	}
	if enforcing && acting == "" {
		return "", ErrActingAccountRequired
	}
	if a.tickets == nil {
		if ownerOnly || enforcing {
			// Fail closed: if ticket ownership cannot be resolved, the caller is not authorized.
			return "", ErrForbidden
		}
		return "", nil
	}
	owner, err := a.tickets.LookupTicketOwnership(ctx, eventID)
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrNotFound):
			if ownerOnly || enforcing {
				return "", err
			}
		case enforcing:
			return "", fmt.Errorf("%w: %v", ErrTicketLookupUnavailable, err)
		case ownerOnly:
			return "", err
		}
		return "", nil
	}
	if enforcing && acting != owner.AccountID {
		return "", ErrForbidden
	}
	legacy := !ownerOnly || owner.UserID == caller.UserID
	d, err := a.decide(ctx, caller, perm, authz.Scope{AccountID: owner.AccountID, EventID: eventID}, legacy)
	if err != nil {
		return "", err
	}
	if acting != "" && acting == owner.AccountID && (enforcing || d.Reason == authz.ReasonAllowed) {
		return acting, nil
	}
	return "", nil
}

// logModeBudget bounds the log-mode comparison on validateScan, which made no
// remote call before the check existed: a slow or down service must not stall scans.
const logModeBudget = 300 * time.Millisecond

// AuthorizeScanToken checks attendance.scan for the event a signed admission
// token names. validateScan had no check before, so outside enforcement the
// answer is only compared and logged, and in logging mode only within
// logModeBudget. A token with a good signature names a trustworthy event even
// when expired, so it is checked and the caller then validates as before. A
// token whose signature fails names no event: enforcement returns
// ErrScanTokenUnverifiable rather than let a non-member probe tokens.
func (a *OrganizerAccess) AuthorizeScanToken(ctx context.Context, caller security.TrustedCaller, acting, token string) (string, error) {
	var claims *qr.Claims
	if a.tokens != nil {
		claims, _ = a.tokens.VerifySigned(token)
	}
	if claims == nil {
		if a.Enforcing() {
			return "", ErrScanTokenUnverifiable
		}
		return "", nil
	}
	if !a.logging() {
		return a.AuthorizeEvent(ctx, caller, acting, PermAttendanceScan, claims.EventID, false)
	}
	// The goroutine lets the bound hold even if a lookup ignores its context.
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = a.AuthorizeEvent(ctx, caller, acting, PermAttendanceScan, claims.EventID, false)
	}()
	select {
	case <-done:
	case <-time.After(logModeBudget):
		a.log.Warn("authz comparison for validateScan timed out", zap.String("eventId", claims.EventID))
	}
	return "", nil
}

// decide answers one permission question. legacyAllowed is what the old rule
// says. Enforcing, the permission service decides and fails closed; logging,
// the old rule decides and any difference is recorded; otherwise the old rule
// decides.
func (a *OrganizerAccess) decide(ctx context.Context, caller security.TrustedCaller, perm string, scope authz.Scope, legacyAllowed bool) (authz.Decision, error) {
	logged := authz.ReasonOff
	switch {
	case a.Enforcing():
		if scope.AccountID == "" {
			return authz.Decision{Reason: authz.ReasonNotMember}, ErrForbidden
		}
		d, err := a.authz.Check(ctx, caller, perm, scope)
		if err != nil {
			if errors.Is(err, authz.ErrAuthzUnavailable) {
				return d, err
			}
			a.log.Error("authz rejected an attendance-service request", zap.String("permission", perm), zap.Error(err))
			return d, fmt.Errorf("%w: %v", ErrPermissionCheckFailed, err)
		}
		if !d.Allowed {
			return d, ErrForbidden
		}
		return d, nil
	case a.logging() && scope.AccountID != "":
		d, err := a.authz.Check(ctx, caller, perm, scope)
		if err == nil {
			logged = d.Reason
		}
		if err == nil && decided(d.Reason) {
			if newAllowed := d.Reason == authz.ReasonAllowed; newAllowed != legacyAllowed {
				authzDisagreements.WithLabelValues(perm, allowName(legacyAllowed), allowName(newAllowed)).Inc()
				a.log.Warn("authz disagrees with the owner check",
					zap.String("permission", perm), zap.String("userId", caller.UserID),
					zap.String("accountId", scope.AccountID), zap.String("eventId", scope.EventID),
					zap.Bool("ownerCheckAllowed", legacyAllowed), zap.String("authzReason", d.Reason))
			}
		}
	}
	if !legacyAllowed {
		return authz.Decision{}, ErrForbidden
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

// Audited runs change and writes the audit entry in the same transaction, so
// the two commit or roll back together. build runs after change. Without
// auditing (mode off) it just runs change.
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

// SavePolicy stores the policy and, when auditing, the audit entry naming the
// verified actor, in one transaction. before is nil when no policy row existed.
// A nil OrganizerAccess just stores the policy.
func (a *OrganizerAccess) SavePolicy(ctx context.Context, svc AttendanceService, caller security.TrustedCaller, account string, before, policy *repository.AttendancePolicy) error {
	if a == nil {
		return svc.UpsertAttendancePolicy(ctx, policy)
	}
	entry := PolicyEditEntry(ctx, caller.UserID, account, before, policy)
	if len(entry.After) == 0 {
		return svc.UpsertAttendancePolicy(ctx, policy)
	}
	return a.Audited(ctx,
		func() audit.Entry { return entry },
		func(ctx context.Context) error { return svc.UpsertAttendancePolicy(ctx, policy) })
}

func policyFields(p *repository.AttendancePolicy) map[string]any {
	return map[string]any{"requireQrForEntry": p.RequireQRForEntry, "allowManualOverride": p.AllowManualOverride}
}

// PolicyEditEntry describes a policy change with only the fields whose values
// differ. A nil before (no policy row yet) records every field as new.
func PolicyEditEntry(ctx context.Context, actorUserID, actorAccountID string, before, after *repository.AttendancePolicy) audit.Entry {
	var prev map[string]any
	if before != nil {
		prev = policyFields(before)
	}
	b, n := map[string]any{}, map[string]any{}
	for k, nv := range policyFields(after) {
		pv, had := prev[k]
		if had && reflect.DeepEqual(pv, nv) {
			continue
		}
		n[k] = nv
		if had {
			b[k] = pv
		}
	}
	if len(b) == 0 {
		b = nil
	}
	traceID := ""
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		traceID = sc.TraceID().String()
	}
	return audit.Entry{
		ActorUserID: actorUserID, ActorAccountID: actorAccountID,
		Action: ActionPolicyUpdate, Resource: "attendance_policy:" + after.EventID,
		Before: b, After: n, TraceID: traceID,
	}
}
