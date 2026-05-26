package graph

import (
	"context"
	"net/http"
)

type contextKey string

const requestContextKey contextKey = "httpRequest"

// WithHTTPRequest stores the HTTP request in the context for use by resolvers.
func WithHTTPRequest(ctx context.Context, r *http.Request) context.Context {
	return context.WithValue(ctx, requestContextKey, r)
}

// userIDFromContext extracts the X-User-Id header from the HTTP request stored
// in context. Returns an empty string when no request or header is present.
func userIDFromContext(ctx context.Context) string {
	r, ok := ctx.Value(requestContextKey).(*http.Request)
	if !ok || r == nil {
		return ""
	}
	return r.Header.Get("X-User-Id")
}
