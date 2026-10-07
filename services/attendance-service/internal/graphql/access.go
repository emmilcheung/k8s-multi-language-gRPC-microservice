package graph

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/acme/attendance-service/internal/authz"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/security"
	"github.com/acme/attendance-service/internal/service"
)

func requestHeader(ctx context.Context) http.Header {
	if req, ok := ctx.Value(requestContextKey).(*http.Request); ok && req != nil {
		return req.Header
	}
	return http.Header{}
}

// authorizeEvent runs the organizer and staff permission check for an event.
// Without an OrganizerAccess it keeps the old creator-only comparison. It
// returns the verified caller and the organizer account the check vouches for;
// errors are already in the resolver error format.
func (r *Resolver) authorizeEvent(ctx context.Context, perm, eventID, userID string) (security.TrustedCaller, string, error) {
	if r.Access == nil {
		return security.TrustedCaller{UserID: userID}, "", accessError(r.Svc.EnsureOrganizerOwnsEvent(ctx, eventID, userID))
	}
	caller, acting, err := r.Access.Caller(requestHeader(ctx), userID)
	if err != nil {
		return caller, "", accessError(err)
	}
	account, err := r.Access.AuthorizeEvent(ctx, caller, acting, perm, eventID, true)
	return caller, account, accessError(err)
}

// authorizeScanToken checks attendance.scan for the event a token names. The
// old behaviour had no check, which stays the case without an OrganizerAccess.
func (r *Resolver) authorizeScanToken(ctx context.Context, userID, token string) error {
	if r.Access == nil {
		return nil
	}
	caller, acting, err := r.Access.Caller(requestHeader(ctx), userID)
	if err != nil {
		return accessError(err)
	}
	_, err = r.Access.AuthorizeScanToken(ctx, caller, acting, token)
	return accessError(err)
}

// accessError turns an authorization failure into the resolver error format.
// Permission-check faults never reach the client in detail.
func accessError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, authz.ErrAuthzUnavailable), errors.Is(err, service.ErrTicketLookupUnavailable):
		return fmt.Errorf("unavailable: permission check unavailable, try again")
	case errors.Is(err, service.ErrActingAccountRequired), errors.Is(err, service.ErrActingAccountInvalid):
		return fmt.Errorf("unprocessable: %s", err.Error())
	case errors.Is(err, service.ErrPermissionCheckFailed):
		return fmt.Errorf("internal: permission check failed")
	case errors.Is(err, service.ErrForbidden):
		return fmt.Errorf("forbidden: organizer is not allowed for this event")
	case errors.Is(err, repository.ErrNotFound):
		return fmt.Errorf("not found: event not found")
	}
	return err
}
