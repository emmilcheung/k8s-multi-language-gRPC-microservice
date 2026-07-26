package graph

import "strings"

func normalizeAssignmentMode(mode AssignmentMode) string {
	return strings.ToLower(string(mode))
}
