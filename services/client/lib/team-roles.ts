// Roles a member can hold in an organizer account, with their display names.
export const TEAM_ROLES: { value: string; label: string }[] = [
  { value: "OWNER", label: "Owner" },
  { value: "ADMIN", label: "Admin" },
  { value: "EVENT_MANAGER", label: "Event manager" },
  { value: "FINANCE", label: "Finance" },
  { value: "DOOR_STAFF", label: "Door staff" },
];

/** Owners and admins manage the team; the users subgraph refuses everyone else, so the console hides it. */
export function canManageTeam(role: string | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}
