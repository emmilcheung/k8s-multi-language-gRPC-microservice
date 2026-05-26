package graph

import "testing"

func TestNormalizeAssignmentMode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input AssignmentMode
		want  string
	}{
		{name: "manual", input: AssignmentModeManual, want: "manual"},
		{name: "auto", input: AssignmentModeAuto, want: "auto"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := normalizeAssignmentMode(tt.input)
			if got != tt.want {
				t.Fatalf("normalizeAssignmentMode(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
