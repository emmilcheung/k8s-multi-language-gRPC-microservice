package audit

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestRedactPersonalData_ShouldBlankEmailAndAttendeeNames_WhenPresent(t *testing.T) {
	got := RedactPersonalData(map[string]any{
		"status":        "ACTIVE",
		"contactEmail":  "a@b.com",
		"attendee_name": "Ada Lovelace",
		"nested":        map[string]any{"buyerName": "Bob", "seats": 2},
		"list":          []any{map[string]any{"firstName": "Eve", "row": "A"}},
	})
	assert.Equal(t, map[string]any{
		"status":        "ACTIVE",
		"contactEmail":  "[redacted]",
		"attendee_name": "[redacted]",
		"nested":        map[string]any{"buyerName": "[redacted]", "seats": 2},
		"list":          []any{map[string]any{"firstName": "[redacted]", "row": "A"}},
	}, got)
}

func TestRedactPersonalData_ShouldKeepPlainName_WhenItNamesAnEventOrOrganizer(t *testing.T) {
	got := RedactPersonalData(map[string]any{"name": "Spring Gala"})
	assert.Equal(t, map[string]any{"name": "Spring Gala"}, got)
}

func TestEntryRedacted_ShouldNotChangeTheOriginal(t *testing.T) {
	e := Entry{Before: map[string]any{"attendeeEmail": "a@b.com"}}
	got := e.Redacted()
	assert.Equal(t, "[redacted]", got.Before["attendeeEmail"])
	assert.Equal(t, "a@b.com", e.Before["attendeeEmail"])
}
