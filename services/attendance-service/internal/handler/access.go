package handler

import (
	"errors"
	"net/http"

	"github.com/acme/attendance-service/internal/authz"
	"github.com/acme/attendance-service/internal/security"
	"github.com/acme/attendance-service/internal/service"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// authorizeEvent runs the organizer and staff permission check for an event.
// Without an OrganizerAccess it keeps the old creator-only comparison. It
// returns the verified caller and the organizer account the check vouches for.
func authorizeEvent(c echo.Context, svc service.AttendanceService, access *service.OrganizerAccess, perm, eventID, userID string) (security.TrustedCaller, string, error) {
	ctx := c.Request().Context()
	if access == nil {
		return security.TrustedCaller{UserID: userID}, "", svc.EnsureOrganizerOwnsEvent(ctx, eventID, userID)
	}
	caller, acting, err := access.Caller(c.Request().Header, userID)
	if err != nil {
		return caller, "", err
	}
	account, err := access.AuthorizeEvent(ctx, caller, acting, perm, eventID, true)
	return caller, account, err
}

// accessFailure writes the response for a permission-check failure and reports
// whether it did. Refusals and not-found keep the handlers' existing mapping.
// Permission-check faults never reach the client in detail.
func accessFailure(c echo.Context, log *zap.Logger, err error) (bool, error) {
	switch {
	case errors.Is(err, authz.ErrAuthzUnavailable), errors.Is(err, service.ErrTicketLookupUnavailable):
		return true, jsonError(c, http.StatusServiceUnavailable, "PERMISSION_CHECK_UNAVAILABLE", "permission check unavailable, try again")
	case errors.Is(err, service.ErrActingAccountRequired), errors.Is(err, service.ErrActingAccountInvalid):
		return true, jsonError(c, http.StatusBadRequest, "INVALID_ACCOUNT", err.Error())
	case errors.Is(err, service.ErrPermissionCheckFailed):
		log.Error("attendance permission check failed", zap.Error(err))
		return true, jsonError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "internal server error")
	}
	return false, nil
}
