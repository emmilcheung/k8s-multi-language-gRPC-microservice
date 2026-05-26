package graph

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/acme/ticket-service/internal/security"
)

func TestWrapWithUserIDSignatureValidation_InvalidSignatureReturnsUnauthorized(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("test-key")
	wrapped := WrapWithUserIDSignatureValidation(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), validator)

	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	req.Header.Set("X-User-Id", "user-123")
	req.Header.Set("X-User-Id-Sig", "invalid")
	res := httptest.NewRecorder()

	wrapped.ServeHTTP(res, req)

	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", res.Code)
	}
}
