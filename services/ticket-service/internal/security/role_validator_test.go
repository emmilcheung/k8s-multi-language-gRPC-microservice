package security

import (
	"testing"
)

func TestParseUserRolesEmpty(t *testing.T) {
	roles := ParseUserRoles("")
	if len(roles) != 0 {
		t.Error("Should return empty set for empty header")
	}
}

func TestParseUserRolesSingle(t *testing.T) {
	roles := ParseUserRoles("organizer")
	if !roles["organizer"] {
		t.Error("Should parse single role")
	}
	if len(roles) != 1 {
		t.Error("Should have exactly one role")
	}
}

func TestParseUserRolesMultiple(t *testing.T) {
	roles := ParseUserRoles("organizer,buyer")
	if !roles["organizer"] {
		t.Error("Should contain organizer role")
	}
	if !roles["buyer"] {
		t.Error("Should contain buyer role")
	}
	if len(roles) != 2 {
		t.Error("Should have exactly two roles")
	}
}

func TestParseUserRolesWithSpaces(t *testing.T) {
	roles := ParseUserRoles("organizer, buyer, admin")
	if !roles["organizer"] {
		t.Error("Should contain organizer role")
	}
	if !roles["buyer"] {
		t.Error("Should contain buyer role")
	}
	if !roles["admin"] {
		t.Error("Should contain admin role")
	}
	if len(roles) != 3 {
		t.Error("Should have exactly three roles")
	}
}

func TestParseUserRolesLeadingTrailingSpaces(t *testing.T) {
	roles := ParseUserRoles("  organizer  ,  buyer  ")
	if !roles["organizer"] {
		t.Error("Should parse role with leading/trailing spaces")
	}
	if !roles["buyer"] {
		t.Error("Should parse role with leading/trailing spaces")
	}
	if len(roles) != 2 {
		t.Error("Should have exactly two roles")
	}
}

func TestHasRoleTrue(t *testing.T) {
	roles := ParseUserRoles("organizer,buyer")
	if !HasRole(roles, "organizer") {
		t.Error("Should return true for role that exists")
	}
}

func TestHasRoleFalse(t *testing.T) {
	roles := ParseUserRoles("buyer")
	if HasRole(roles, "organizer") {
		t.Error("Should return false for role that does not exist")
	}
}

func TestHasRoleEmptySet(t *testing.T) {
	roles := ParseUserRoles("")
	if HasRole(roles, "organizer") {
		t.Error("Should return false for role in empty set")
	}
}
