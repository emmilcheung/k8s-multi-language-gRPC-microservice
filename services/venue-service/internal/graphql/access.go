package graph

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/acme/venue-service/internal/authz"
	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/acme/venue-service/internal/service"
	"go.uber.org/zap"
)

// legacyOrg keeps the old creator-only comparison for a Resolver built without
// organizer access.
var legacyOrg = service.NewOrganizerAccess(nil, authz.ModeOff, nil, nil, zap.NewNop())

func (r *Resolver) org() *service.OrganizerAccess {
	if r.Access != nil {
		return r.Access
	}
	return legacyOrg
}

// organizerCaller returns the verified caller and the organizer account they
// selected with X-Organizer-Account.
func (r *Resolver) organizerCaller(ctx context.Context, userID string) (security.TrustedCaller, string, error) {
	caller := security.TrustedCaller{UserID: userID}
	var header http.Header
	if req, ok := ctx.Value(requestContextKey).(*http.Request); ok && req != nil {
		header = req.Header
	}
	if r.Verifier != nil && header != nil {
		caller = r.Verifier.TrustedCaller(userID, header.Get("X-User-Id-Sig"), header.Get("X-User-Roles"), header.Get("X-User-Roles-Sig"))
		caller = service.WithCallerUser(caller, userID)
	}
	acting, err := r.org().ActingAccount(header.Get("X-Organizer-Account"))
	return caller, acting, accessError(r.org(), err, "")
}

// accessError turns an authorization failure into the resolver error format.
// A refusal keeps legacyMsg (what it said before the permission check existed)
// unless enforcement is on. Permission-check faults never reach the client in
// detail.
func accessError(org *service.OrganizerAccess, err error, legacyMsg string) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, authz.ErrAuthzUnavailable), errors.Is(err, service.ErrTicketLookupUnavailable):
		return fmt.Errorf("unavailable: permission check unavailable, try again")
	case errors.Is(err, service.ErrActingAccountRequired), errors.Is(err, service.ErrActingAccountInvalid):
		return fmt.Errorf("unprocessable: %s", err.Error())
	case errors.Is(err, service.ErrTicketNotFound):
		return fmt.Errorf("not found: ticket not found")
	case errors.Is(err, service.ErrUnauthorized):
		if org.Enforcing() || legacyMsg == "" {
			return fmt.Errorf("forbidden: not allowed to change this resource")
		}
		return errors.New(legacyMsg)
	}
	return fmt.Errorf("internal: permission check failed")
}

func venueSectionFields(vs *repository.VenueSection) map[string]any {
	return map[string]any{
		"venueId": vs.VenueID, "name": vs.Name, "type": string(vs.Type),
		"rowCount": vs.RowCount, "columnCount": vs.ColumnCount, "displayOrder": vs.DisplayOrder,
	}
}

// authorizePlanEdit checks the caller may change the plan and returns the
// verified caller and the account the check vouches for.
func (r *Resolver) authorizePlanEdit(ctx context.Context, organizerID string, plan *repository.SeatingPlan, legacyMsg string) (security.TrustedCaller, string, error) {
	caller, acting, err := r.organizerCaller(ctx, organizerID)
	if err != nil {
		return caller, "", err
	}
	account, err := r.org().AuthorizePlanEdit(ctx, caller, acting, plan)
	if err != nil {
		return caller, "", accessError(r.org(), err, legacyMsg)
	}
	return caller, account, nil
}
