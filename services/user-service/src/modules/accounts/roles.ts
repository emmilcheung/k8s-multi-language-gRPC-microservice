export enum Roles {
  OWNER = "OWNER",
  ADMIN = "ADMIN",
  EVENT_MANAGER = "EVENT_MANAGER",
  FINANCE = "FINANCE",
  DOOR_STAFF = "DOOR_STAFF",
  VENUE_MANAGER = "VENUE_MANAGER",
}

// Roles a member of an organizer account can hold, highest first.
// VENUE_MANAGER belongs to venue memberships, not accounts.
export const ACCOUNT_ROLES: readonly Roles[] = [
  Roles.OWNER,
  Roles.ADMIN,
  Roles.EVENT_MANAGER,
  Roles.FINANCE,
  Roles.DOOR_STAFF,
];

// Higher number = more authority. Only meaningful for ACCOUNT_ROLES.
export function roleRank(role: Roles): number {
  return ACCOUNT_ROLES.length - ACCOUNT_ROLES.indexOf(role);
}

export function isAccountRole(role: string): role is Roles {
  return (ACCOUNT_ROLES as readonly string[]).includes(role);
}
