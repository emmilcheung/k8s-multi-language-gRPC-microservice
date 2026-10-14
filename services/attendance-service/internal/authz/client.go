// Package authz asks user-service whether a caller may act on an organizer
// account, venue or event. It is used for organizer and staff operations only;
// buyer paths never call it.
package authz

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	accountsv1 "github.com/org/ticketing/libs/grpc-stubs/go/accounts/v1"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/acme/attendance-service/internal/security"
)

const (
	// DefaultCacheTTL bounds how long a removed member keeps access.
	DefaultCacheTTL = 30 * time.Second
	// callTimeout keeps a slow user-service from hanging organizer writes.
	callTimeout = 300 * time.Millisecond
	// maxCacheEntries stops a flood of distinct requests from growing memory.
	maxCacheEntries = 10_000
	// unavailableWindow is how long log mode skips user-service after a failed
	// call, so an outage does not add the call timeout to every request. It is
	// also the minimum gap between "unavailable" warnings.
	unavailableWindow = 5 * time.Second
)

// Decision reasons. ReasonAllowed is set when the request is permitted.
const (
	ReasonAllowed             = "allowed"
	ReasonNotMember           = "not_member"
	ReasonRoleLacksPermission = "role_lacks_permission"
	ReasonAccountSuspended    = "account_suspended"
	ReasonOutOfScope          = "out_of_scope"
	ReasonUnknown             = "unknown"
	ReasonUnavailable         = "unavailable"
	ReasonOff                 = "off"
)

// ErrAuthzUnavailable means user-service could not answer in time. Callers
// that enforce map it to 503 for organizer writes. Only log mode remembers it,
// briefly, to skip the call; enforcing modes ask again every time.
var ErrAuthzUnavailable = errors.New("authz: user-service unavailable")

// Mode is the AUTHZ_ENFORCED setting.
type Mode string

const (
	// ModeOff never calls user-service.
	ModeOff Mode = "off"
	// ModeLog asks, records would-deny, and never blocks: the old check decides.
	ModeLog Mode = "log"
	// ModeOn enforces the answer and fails closed when user-service is down.
	ModeOn Mode = "on"
)

// ParseMode validates an AUTHZ_ENFORCED value.
func ParseMode(s string) (Mode, error) {
	switch m := Mode(s); m {
	case ModeOff, ModeLog, ModeOn:
		return m, nil
	}
	return "", fmt.Errorf("must be one of off, log, on, got %q", s)
}

// Scope names the resource a permission applies to.
type Scope struct {
	AccountID string
	VenueID   string
	EventID   string
}

// Decision is user-service's answer. Reason is one of the Reason* constants.
type Decision struct {
	Allowed bool
	Reason  string
}

var decisions = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "authz_decisions_total",
	Help: "Authorization decisions by enforcement mode, result and reason.",
}, []string{"mode", "result", "reason"})

type cacheEntry struct {
	decision Decision
	expires  time.Time
}

// Client checks permissions against user-service, caching answers briefly.
type Client struct {
	mode Mode
	rpc  accountsv1.AccountsServiceClient // nil when no address is configured
	log  *zap.Logger
	ttl  time.Duration
	now  func() time.Time

	mu    sync.Mutex
	cache map[string]cacheEntry
	// downUntil and lastWarn are only used in log mode.
	downUntil time.Time
	lastWarn  time.Time
}

// Option customises a Client.
type Option func(*Client)

// WithClock replaces the time source (tests).
func WithClock(now func() time.Time) Option { return func(c *Client) { c.now = now } }

// WithTTL overrides DefaultCacheTTL.
func WithTTL(ttl time.Duration) Option { return func(c *Client) { c.ttl = ttl } }

// New builds a Client. rpc may be nil, which only makes sense outside ModeOn.
func New(mode Mode, rpc accountsv1.AccountsServiceClient, log *zap.Logger, opts ...Option) *Client {
	c := &Client{
		mode:  mode,
		rpc:   rpc,
		log:   log,
		ttl:   DefaultCacheTTL,
		now:   time.Now,
		cache: make(map[string]cacheEntry),
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Check asks whether caller may exercise perm on scope.
//
// ModeOff and ModeLog always return Allowed with a nil error. ModeOn returns
// ErrAuthzUnavailable (with Allowed false) when user-service cannot answer.
func (c *Client) Check(ctx context.Context, caller security.TrustedCaller, perm string, scope Scope) (Decision, error) {
	if c.mode == ModeOff {
		return Decision{Allowed: true, Reason: ReasonOff}, nil
	}

	d, err := c.lookup(ctx, caller, perm, scope)
	if err != nil {
		if c.mode == ModeOn {
			if errors.Is(err, ErrAuthzUnavailable) {
				decisions.WithLabelValues(string(c.mode), "deny", ReasonUnavailable).Inc()
				c.log.Error("authz check failed closed", zap.String("permission", perm), zap.Error(err))
				return Decision{Reason: ReasonUnavailable}, err
			}
			return Decision{Reason: ReasonUnknown}, err
		}
		decisions.WithLabelValues(string(c.mode), "unavailable", ReasonUnavailable).Inc()
		if c.shouldWarnUnavailable() {
			c.log.Warn("authz would-check unavailable",
				zap.String("permission", perm), zap.Error(err))
		}
		return Decision{Allowed: true, Reason: ReasonUnavailable}, nil
	}

	result := "allow"
	if !d.Allowed {
		result = "deny"
	}
	decisions.WithLabelValues(string(c.mode), result, d.Reason).Inc()

	if c.mode == ModeLog {
		if !d.Allowed {
			c.log.Warn("authz would deny",
				zap.String("permission", perm), zap.String("userId", caller.UserID),
				zap.String("accountId", scope.AccountID), zap.String("venueId", scope.VenueID),
				zap.String("eventId", scope.EventID), zap.String("reason", d.Reason))
		}
		return Decision{Allowed: true, Reason: d.Reason}, nil
	}
	return d, nil
}

// lookup returns the cached or fresh answer. Errors are never cached, except
// that log mode skips the call for unavailableWindow after one fails to answer.
// On mode always asks, so the skip can never turn into a grant or a stale deny.
func (c *Client) lookup(ctx context.Context, caller security.TrustedCaller, perm string, scope Scope) (Decision, error) {
	if c.rpc == nil {
		return Decision{}, fmt.Errorf("%w: ACCOUNTS_GRPC_ADDR is not configured", ErrAuthzUnavailable)
	}

	key := cacheKey(caller, perm, scope)
	if d, ok := c.cached(key); ok {
		return d, nil
	}

	if c.mode == ModeLog && c.skipping() {
		return Decision{}, fmt.Errorf("%w: skipping the call after a recent failure", ErrAuthzUnavailable)
	}

	callCtx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	resp, err := c.rpc.CheckPermission(callCtx, &accountsv1.CheckPermissionRequest{
		UserId:        caller.UserID,
		PlatformRoles: caller.PlatformRoles,
		Permission:    perm,
		AccountId:     scope.AccountID,
		VenueId:       scope.VenueID,
		EventId:       scope.EventID,
	})
	if err != nil {
		if status.Code(err) == codes.InvalidArgument {
			return Decision{}, fmt.Errorf("authz: user-service rejected the request: %w", err)
		}
		if c.mode == ModeLog {
			c.markDown()
		}
		return Decision{}, fmt.Errorf("%w: %v", ErrAuthzUnavailable, err)
	}

	d := Decision{Allowed: resp.GetAllowed(), Reason: reasonName(resp)}
	c.store(key, d)
	return d, nil
}

func (c *Client) skipping() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now().Before(c.downUntil)
}

func (c *Client) markDown() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.downUntil = c.now().Add(unavailableWindow)
}

// shouldWarnUnavailable lets one warning through per unavailableWindow.
func (c *Client) shouldWarnUnavailable() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if now.Sub(c.lastWarn) < unavailableWindow {
		return false
	}
	c.lastWarn = now
	return true
}

func reasonName(resp *accountsv1.CheckPermissionResponse) string {
	if resp.GetAllowed() {
		return ReasonAllowed
	}
	switch resp.GetReasonCode() {
	case accountsv1.ReasonCode_REASON_CODE_NOT_MEMBER:
		return ReasonNotMember
	case accountsv1.ReasonCode_REASON_CODE_ROLE_LACKS_PERMISSION:
		return ReasonRoleLacksPermission
	case accountsv1.ReasonCode_REASON_CODE_ACCOUNT_SUSPENDED:
		return ReasonAccountSuspended
	case accountsv1.ReasonCode_REASON_CODE_OUT_OF_SCOPE:
		return ReasonOutOfScope
	}
	return ReasonUnknown
}

func (c *Client) cached(key string) (Decision, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[key]
	if !ok || !c.now().Before(e.expires) {
		delete(c.cache, key)
		return Decision{}, false
	}
	return e.decision, true
}

func (c *Client) store(key string, d Decision) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cache) >= maxCacheEntries {
		now := c.now()
		for k, e := range c.cache {
			if !now.Before(e.expires) {
				delete(c.cache, k)
			}
		}
		if len(c.cache) >= maxCacheEntries {
			clear(c.cache)
		}
	}
	c.cache[key] = cacheEntry{decision: d, expires: c.now().Add(c.ttl)}
}

// cacheKey covers the whole request so one caller's answer never serves another.
// Fields are NUL-separated; ids and permission names never contain NUL.
func cacheKey(caller security.TrustedCaller, perm string, scope Scope) string {
	roles := append([]string(nil), caller.PlatformRoles...)
	sort.Strings(roles)
	return strings.Join([]string{caller.UserID, strings.Join(roles, ","), perm, scope.AccountID, scope.VenueID, scope.EventID}, "\x00")
}
