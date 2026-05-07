package middleware

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

const (
	// ContextKeyUserID is the Echo context key for the authenticated user ID.
	ContextKeyUserID = "userId"
)

// KongAuth extracts the X-User-Id header injected by Kong and places it in
// the Echo context. Requests without the header are rejected with 401.
// Pass requireAuth=false to skip enforcement (e.g. on scanner endpoints that
// authenticate via device token in a later workstream).
func KongAuth(requireAuth bool) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			userID := c.Request().Header.Get("X-User-Id")
			if userID == "" && requireAuth {
				return c.JSON(http.StatusUnauthorized, map[string]interface{}{
					"error": map[string]string{
						"code":    "MISSING_USER_ID",
						"message": "unauthorized",
					},
				})
			}
			if userID != "" {
				c.Set(ContextKeyUserID, userID)
			}
			return next(c)
		}
	}
}

// RequireUserID is a helper that retrieves the user ID from context,
// returning an empty string if not present.
func RequireUserID(c echo.Context) string {
	v, _ := c.Get(ContextKeyUserID).(string)
	return v
}
