package graph_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	graph "github.com/acme/venue-service/internal/graphql"
	"github.com/acme/venue-service/internal/security"
)

func TestWrapWithUserIDSignatureValidation(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("test-key")

	baseHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := graph.WrapWithUserIDSignatureValidation(baseHandler, validator)

	tests := []struct {
		name       string
		userID     string
		sig        string
		wantStatus int
	}{
		{
			name:       "unauthenticated request passes through",
			wantStatus: http.StatusOK,
		},
		{
			name:       "user id with missing signature is rejected",
			userID:     "user-123",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "user id with invalid signature is rejected",
			userID:     "user-123",
			sig:        "invalid-sig",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
			if tt.userID != "" {
				req.Header.Set("X-User-Id", tt.userID)
			}
			if tt.sig != "" {
				req.Header.Set("X-User-Id-Sig", tt.sig)
			}

			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Fatalf("got status %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

func TestWrapWithUserIDSignatureValidation_EmptyKeySkipsValidation(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("")

	baseHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := graph.WrapWithUserIDSignatureValidation(baseHandler, validator)
	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	req.Header.Set("X-User-Id", "user-123")

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("empty signing key should skip validation, got status %d, want %d", w.Code, http.StatusOK)
	}
}
