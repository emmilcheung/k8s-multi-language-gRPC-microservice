package graph

import (
	"context"

	"github.com/acme/ticket-service/internal/security"
)

type userIDContextKey struct{}

func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDContextKey{}, userID)
}

func userIDFromContext(ctx context.Context) string {
	userID, _ := ctx.Value(userIDContextKey{}).(string)
	return userID
}

type callerContextKey struct{}

// WithCaller stores the gateway-verified caller (user id plus signed platform roles).
func WithCaller(ctx context.Context, caller security.TrustedCaller) context.Context {
	return context.WithValue(ctx, callerContextKey{}, caller)
}

// callerFromContext returns the verified caller, or one built from the user id
// alone when no verified caller was stored.
func callerFromContext(ctx context.Context) security.TrustedCaller {
	if c, ok := ctx.Value(callerContextKey{}).(security.TrustedCaller); ok && c.UserID != "" {
		return c
	}
	return security.TrustedCaller{UserID: userIDFromContext(ctx)}
}

type organizerAccountContextKey struct{}

// WithOrganizerAccount stores the X-Organizer-Account selector.
func WithOrganizerAccount(ctx context.Context, accountID string) context.Context {
	return context.WithValue(ctx, organizerAccountContextKey{}, accountID)
}

func organizerAccountFromContext(ctx context.Context) string {
	id, _ := ctx.Value(organizerAccountContextKey{}).(string)
	return id
}
