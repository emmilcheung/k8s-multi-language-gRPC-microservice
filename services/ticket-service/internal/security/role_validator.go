package security

import (
	"strings"
)

// ParseUserRoles parses a comma-separated X-User-Roles header and returns the roles as a set.
// Whitespace around roles is trimmed. Returns an empty set if the header is empty.
func ParseUserRoles(rolesHeader string) map[string]bool {
	roles := make(map[string]bool)
	if rolesHeader == "" {
		return roles
	}
	parts := strings.Split(rolesHeader, ",")
	for _, part := range parts {
		role := strings.TrimSpace(part)
		if role != "" {
			roles[role] = true
		}
	}
	return roles
}

// HasRole checks if a roles set contains the target role.
func HasRole(roles map[string]bool, targetRole string) bool {
	return roles[targetRole]
}
