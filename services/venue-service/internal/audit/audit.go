// Package audit records who changed what, inside the same database
// transaction as the change, so the two commit or roll back together.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Entry is one audit row. Before and After hold only the fields that changed.
type Entry struct {
	At             time.Time // zero means now
	ActorUserID    string
	ActorAccountID string
	Action         string
	Resource       string
	Before         map[string]any
	After          map[string]any
	Reason         string
	TraceID        string
}

const redacted = "[redacted]"

// personNameKeys are person-name fields. A bare "name" is deliberately absent:
// it is a venue, plan or event name, not personal data.
var personNameKeys = map[string]bool{
	"firstname": true, "lastname": true, "fullname": true, "displayname": true,
	"holdername": true, "buyername": true, "guestname": true,
}

// isPersonalKey matches by key, not value: any email field, anything about an
// attendee, and person-name fields. Audit history must not outlive an
// attendee's right to be forgotten, so this is enforced at write time rather
// than trusted to each caller.
func isPersonalKey(key string) bool {
	var b strings.Builder
	for _, r := range strings.ToLower(key) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	k := b.String()
	return strings.Contains(k, "email") || strings.HasPrefix(k, "attendee") || personNameKeys[k]
}

func redactValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		return RedactPersonalData(x)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = redactValue(e)
		}
		return out
	default:
		return v
	}
}

// RedactPersonalData returns a copy with personal values blanked; the key stays
// so the history still shows that the field changed.
func RedactPersonalData(data map[string]any) map[string]any {
	out := make(map[string]any, len(data))
	for k, v := range data {
		if isPersonalKey(k) {
			out[k] = redacted
		} else {
			out[k] = redactValue(v)
		}
	}
	return out
}

func toJSON(m map[string]any) ([]byte, error) {
	if m == nil {
		return nil, nil
	}
	return json.Marshal(RedactPersonalData(m))
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Record writes the entry on the caller's transaction.
func Record(ctx context.Context, tx pgx.Tx, e Entry) error {
	if e.ActorUserID == "" || e.Action == "" || e.Resource == "" {
		return errors.New("audit: actor, action and resource are required")
	}
	before, err := toJSON(e.Before)
	if err != nil {
		return fmt.Errorf("audit: marshal before: %w", err)
	}
	after, err := toJSON(e.After)
	if err != nil {
		return fmt.Errorf("audit: marshal after: %w", err)
	}
	at := e.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log (at, actor_user_id, actor_account_id, action, resource, before, after, reason, trace_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		at, e.ActorUserID, nullIfEmpty(e.ActorAccountID), e.Action, e.Resource,
		before, after, nullIfEmpty(e.Reason), nullIfEmpty(e.TraceID))
	if err != nil {
		return fmt.Errorf("audit: insert: %w", err)
	}
	return nil
}
