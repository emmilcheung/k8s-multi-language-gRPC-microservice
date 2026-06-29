package graph_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/99designs/gqlgen/graphql/handler"
	graph "github.com/acme/ticket-service/internal/graphql"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/security"
	"github.com/stretchr/testify/require"
)

// TestSchemaWiring verifies that the GraphQL schema and resolver plumbing compile
// and wire together correctly without panicking at construction time.
func TestSchemaWiring(t *testing.T) {
	r := &graph.Resolver{} // nil TicketService — only tests wiring, not runtime calls
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: r})
	srv := handler.NewDefaultServer(schema)
	if srv == nil {
		t.Fatal("expected non-nil handler")
	}
	t.Log("GraphQL schema and resolver wiring compiles correctly")
}

// TestTicketTypeEnums verifies the generated enum values match the expected string constants.
func TestTicketTypeEnums(t *testing.T) {
	if graph.TicketTypeGeneralAdmission.String() != "GENERAL_ADMISSION" {
		t.Errorf("expected GENERAL_ADMISSION, got %s", graph.TicketTypeGeneralAdmission.String())
	}
	if graph.TicketTypeSeated.String() != "SEATED" {
		t.Errorf("expected SEATED, got %s", graph.TicketTypeSeated.String())
	}
}

// Compile-time assertion: PaginationParams zero value is usable (prevents import drift).
var _ = repository.PaginationParams{}

// TestGraphQLSignatureValidation verifies that the GraphQL endpoint rejects
// requests with invalid x-user-id-sig when a signing key is configured.
func TestGraphQLSignatureValidation(t *testing.T) {
	// Create validator with a test key
	validator := security.NewUserIDSignatureValidator("test-key")

	// Create a minimal GraphQL handler with signature validation
	r := &graph.Resolver{} // nil TicketService — only tests auth layer
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: r})
	srv := handler.NewDefaultServer(schema)

	gqlHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		userID := req.Header.Get("X-User-Id")
		sig := req.Header.Get("X-User-Id-Sig")
		if userID != "" && !validator.IsValidSignature(userID, sig) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"errors":[{"message":"unauthorized: invalid user identity signature"}]}`)) //nolint:errcheck
			return
		}
		srv.ServeHTTP(w, req)
	})

	tests := []struct {
		name       string
		userID     string
		sig        string
		wantStatus int
	}{
		{
			name:       "no user ID passes through",
			userID:     "",
			sig:        "",
			wantStatus: http.StatusOK,
		},
		{
			name:       "invalid signature returns 401",
			userID:     "user-123",
			sig:        "invalid-sig",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "missing signature with user ID returns 401",
			userID:     "user-123",
			sig:        "",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := `{"query":"{ __typename }"}`
			req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			if tt.userID != "" {
				req.Header.Set("X-User-Id", tt.userID)
			}
			if tt.sig != "" {
				req.Header.Set("X-User-Id-Sig", tt.sig)
			}

			w := httptest.NewRecorder()
			gqlHandler.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("got status %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

// TestGraphQLSignatureValidation_EmptyKey verifies that signature validation
// is skipped when the signing key is empty (graceful degradation).
func TestGraphQLSignatureValidation_EmptyKey(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("")

	r := &graph.Resolver{}
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: r})
	srv := handler.NewDefaultServer(schema)

	gqlHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		userID := req.Header.Get("X-User-Id")
		sig := req.Header.Get("X-User-Id-Sig")
		if userID != "" && !validator.IsValidSignature(userID, sig) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"errors":[{"message":"unauthorized: invalid user identity signature"}]}`)) //nolint:errcheck
			return
		}
		srv.ServeHTTP(w, req)
	})

	body := `{"query":"{ __typename }"}`
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", "user-123")

	w := httptest.NewRecorder()
	gqlHandler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("empty key should skip validation, got status %d, want %d", w.Code, http.StatusOK)
	}
}

// TestSaveEventMutation_RequiresAuth verifies saveEvent returns an error without a user.
func TestSaveEventMutation_RequiresAuth(t *testing.T) {
	r := &graph.Resolver{} // nil TicketService — only tests auth layer
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: r})
	srv := handler.NewDefaultServer(schema)

	gqlHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		userID := req.Header.Get("X-User-Id")
		ctx := req.Context()
		if userID != "" {
			ctx = graph.WithUserID(ctx, userID)
		}
		srv.ServeHTTP(w, req.WithContext(ctx))
	})

	body := `{"query":"mutation { saveEvent(eventId: \"event-123\") { id } }"}`
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No X-User-Id header

	w := httptest.NewRecorder()
	gqlHandler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("GraphQL should return 200 even for errors, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "unauthorized") {
		t.Errorf("expected 'unauthorized' in response, got: %s", w.Body.String())
	}
}

// TestUnsaveEventMutation_RequiresAuth verifies unsaveEvent returns an error without a user.
func TestUnsaveEventMutation_RequiresAuth(t *testing.T) {
	r := &graph.Resolver{} // nil TicketService — only tests auth layer
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: r})
	srv := handler.NewDefaultServer(schema)

	gqlHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		userID := req.Header.Get("X-User-Id")
		ctx := req.Context()
		if userID != "" {
			ctx = graph.WithUserID(ctx, userID)
		}
		srv.ServeHTTP(w, req.WithContext(ctx))
	})

	body := `{"query":"mutation { unsaveEvent(eventId: \"event-123\") { id } }"}`
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No X-User-Id header

	w := httptest.NewRecorder()
	gqlHandler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("GraphQL should return 200 even for errors, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "unauthorized") {
		t.Errorf("expected 'unauthorized' in response, got: %s", w.Body.String())
	}
}

// TestParseCursor_OSPrefix_RestartsOnMongoPath verifies that an "os:"-prefixed
// OpenSearch cursor handed to the Mongo path is treated as invalid — pagination
// restarts at page 1 rather than producing duplicate or skipped results.
func TestParseCursor_OSPrefix_RestartsOnMongoPath(t *testing.T) {
	_, _, ok := repository.ParseCursor("os:1.5:tk1") // os: cursor handed to the Mongo path
	require.False(t, ok)                             // => pagination restarts at page 1, no dup/skip
}

// TestSavedEventsQuery_RequiresAuth verifies savedEvents returns an error without a user.
func TestSavedEventsQuery_RequiresAuth(t *testing.T) {
	r := &graph.Resolver{} // nil TicketService — only tests auth layer
	schema := graph.NewExecutableSchema(graph.Config{Resolvers: r})
	srv := handler.NewDefaultServer(schema)

	gqlHandler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		userID := req.Header.Get("X-User-Id")
		ctx := req.Context()
		if userID != "" {
			ctx = graph.WithUserID(ctx, userID)
		}
		srv.ServeHTTP(w, req.WithContext(ctx))
	})

	body := `{"query":"{ savedEvents(first: 10) { edges { node { id } } } }"}`
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No X-User-Id header

	w := httptest.NewRecorder()
	gqlHandler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("GraphQL should return 200 even for errors, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "unauthorized") {
		t.Errorf("expected 'unauthorized' in response, got: %s", w.Body.String())
	}
}
