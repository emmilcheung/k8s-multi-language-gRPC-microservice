package handler

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/acme/ticket-service/internal/authz"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"go.uber.org/zap"
)

func TestOrganizerAccessError_ShouldMapEachFailureToItsStatus(t *testing.T) {
	cases := []struct {
		name    string
		err     error
		status  int
		handled bool
	}{
		{"no account chosen is the caller's mistake", service.ErrActingAccountRequired, http.StatusBadRequest, true},
		{"a malformed account id is the caller's mistake", service.ErrActingAccountInvalid, http.StatusBadRequest, true},
		{"missing permission is forbidden", fmt.Errorf("wrapped: %w", service.ErrUnauthorized), http.StatusForbidden, true},
		{"permission service down fails closed with 503", authz.ErrAuthzUnavailable, http.StatusServiceUnavailable, true},
		{"permission service rejecting the request is a server fault", fmt.Errorf("%w: bad", service.ErrPermissionCheckFailed), http.StatusInternalServerError, true},
		{"unrelated errors are left to the caller", errors.New("db down"), 0, false},
		{"not found is left to the caller", repository.ErrTicketNotFound, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			c := echo.New().NewContext(httptest.NewRequest(http.MethodPut, "/", nil), rec)

			handled, _ := organizerAccessError(c, zap.NewNop(), tc.err)

			assert.Equal(t, tc.handled, handled)
			if tc.handled {
				assert.Equal(t, tc.status, rec.Code)
			}
		})
	}
}
