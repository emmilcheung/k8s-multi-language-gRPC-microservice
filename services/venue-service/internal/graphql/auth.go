package graph

import (
	"net/http"

	"github.com/acme/venue-service/internal/security"
)

// WrapWithUserIDSignatureValidation rejects requests that carry a user identity
// without the matching signed header. Requests without a user identity continue
// through unchanged to preserve optional-auth behavior during rollout.
func WrapWithUserIDSignatureValidation(next http.Handler, validator *security.UserIDSignatureValidator) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := r.Header.Get("X-User-Id")
		sig := r.Header.Get("X-User-Id-Sig")
		if userID != "" && !validator.IsValidSignature(userID, sig) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"errors":[{"message":"unauthorized: invalid user identity signature"}]}`)) //nolint:errcheck
			return
		}

		next.ServeHTTP(w, r)
	})
}
