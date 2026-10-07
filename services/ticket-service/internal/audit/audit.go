// Package audit defines the audit entry carried inside a ticket outbox event.
// ticket-service has no multi-document transactions, so the entry rides in the
// same single-document update as the outbox event and the relay writes it to
// the audit_log collection.
package audit

import (
	"encoding/json"
	"strings"
	"time"
)

// Entry is one audit record. Before and After hold only the fields that changed.
type Entry struct {
	At             time.Time      `bson:"at"`
	ActorUserID    string         `bson:"actorUserId"`
	ActorAccountID string         `bson:"actorAccountId,omitempty"`
	Action         string         `bson:"action"`
	Resource       string         `bson:"resource"`
	Before         map[string]any `bson:"before,omitempty"`
	After          map[string]any `bson:"after,omitempty"`
	Reason         string         `bson:"reason,omitempty"`
	TraceID        string         `bson:"traceId,omitempty"`
}

const redacted = "[redacted]"

// personNameKeys are person-name fields. A bare "name" is deliberately absent:
// it is an event, venue or organizer name, not personal data.
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
		return redactMap(x)
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
// so the history still shows that the field changed. The input is first
// normalized through JSON, so typed values ([]map[string]any, map[string]string,
// structs) are walked exactly like generic ones. Input that cannot be encoded
// is replaced wholesale rather than stored unchecked.
func RedactPersonalData(data map[string]any) map[string]any {
	if data == nil {
		return nil
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return map[string]any{"unredactable": redacted}
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return map[string]any{"unredactable": redacted}
	}
	return redactMap(generic)
}

func redactMap(data map[string]any) map[string]any {
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

// Redacted returns a copy of the entry that is safe to store.
func (e Entry) Redacted() Entry {
	e.Before = RedactPersonalData(e.Before)
	e.After = RedactPersonalData(e.After)
	return e
}
