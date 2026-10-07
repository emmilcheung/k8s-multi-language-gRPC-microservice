package handler

import (
	"errors"
	"net/http"

	"github.com/acme/venue-service/internal/authz"
	"github.com/acme/venue-service/internal/security"
	"github.com/acme/venue-service/internal/service"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// Access is the organizer permission check the write handlers share. A handler
// built without one keeps the old creator-only comparison.
type Access struct {
	verifier *security.CallerVerifier
	org      *service.OrganizerAccess
}

// NewAccess pairs the gateway-header verifier with the organizer checks.
func NewAccess(verifier *security.CallerVerifier, org *service.OrganizerAccess) *Access {
	return &Access{verifier: verifier, org: org}
}

func legacyAccess(log *zap.Logger) *Access {
	return &Access{org: service.NewOrganizerAccess(nil, authz.ModeOff, nil, nil, log)}
}

// Caller returns the verified caller and the organizer account they selected
// with X-Organizer-Account. userID has already passed the signature check.
func (a *Access) Caller(c echo.Context, userID string) (security.TrustedCaller, string, error) {
	h := c.Request().Header
	caller := security.TrustedCaller{UserID: userID}
	if a.verifier != nil {
		caller = a.verifier.TrustedCaller(userID, h.Get("X-User-Id-Sig"), h.Get("X-User-Roles"), h.Get("X-User-Roles-Sig"))
		caller = service.WithCallerUser(caller, userID)
	}
	acting, err := a.org.ActingAccount(h.Get("X-Organizer-Account"))
	return caller, acting, err
}

// Fail writes the response for an authorization error and reports whether it
// did. A refusal keeps its old status and message unless enforcement is on,
// where it is a plain 403. Permission-check faults never reach the client in
// detail.
func (a *Access) Fail(c echo.Context, log *zap.Logger, err error, legacyStatus int, legacyMsg string) (bool, error) {
	switch {
	case err == nil:
		return false, nil
	case errors.Is(err, authz.ErrAuthzUnavailable), errors.Is(err, service.ErrTicketLookupUnavailable):
		return true, c.JSON(http.StatusServiceUnavailable, errorResponse("permission check unavailable, try again"))
	case errors.Is(err, service.ErrActingAccountRequired), errors.Is(err, service.ErrActingAccountInvalid):
		return true, c.JSON(http.StatusBadRequest, errorResponse(err.Error()))
	case errors.Is(err, service.ErrTicketNotFound):
		return true, c.JSON(http.StatusNotFound, errorResponse("ticket not found"))
	case errors.Is(err, service.ErrUnauthorized):
		if a.org.Enforcing() || legacyStatus == 0 {
			return true, c.JSON(http.StatusForbidden, errorResponse("not allowed to change this resource"))
		}
		return true, c.JSON(legacyStatus, errorResponse(legacyMsg))
	}
	log.Error("organizer permission check failed", zap.Error(err))
	return true, c.JSON(http.StatusInternalServerError, errorResponse("internal error"))
}
