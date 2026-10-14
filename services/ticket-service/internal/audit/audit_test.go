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
		"nested":        map[string]any{"buyerName": "Bob", "seats": float64(2)},
		"list":          []any{map[string]any{"firstName": "Eve", "row": "A"}},
	})
	assert.Equal(t, map[string]any{
		"status":        "ACTIVE",
		"contactEmail":  "[redacted]",
		"attendee_name": "[redacted]",
		"nested":        map[string]any{"buyerName": "[redacted]", "seats": float64(2)},
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

type typedHolder struct {
	AttendeeEmail string `json:"attendeeEmail"`
	Row           string `json:"row"`
}

func TestRedactPersonalData_ShouldBlankPersonalDataInsideTypedNestedValues(t *testing.T) {
	got := RedactPersonalData(map[string]any{
		"rows":    []map[string]any{{"firstName": "Eve", "row": "A"}},
		"labels":  map[string]string{"buyerEmail": "e@x.com", "zone": "Z"},
		"holders": []typedHolder{{AttendeeEmail: "a@b.com", Row: "B"}},
	})
	assert.Equal(t, map[string]any{
		"rows":    []any{map[string]any{"firstName": "[redacted]", "row": "A"}},
		"labels":  map[string]any{"buyerEmail": "[redacted]", "zone": "Z"},
		"holders": []any{map[string]any{"attendeeEmail": "[redacted]", "row": "B"}},
	}, got)
}
