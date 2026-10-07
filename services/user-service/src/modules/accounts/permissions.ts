import { Roles } from "./roles";

// The permission table from the ticketing domain model, implemented once.
// Callers (ticket, venue, attendance and order service) ask CheckPermission
// and never carry their own copy of this table.

export type PlatformRole = "platform_admin" | "platform_support";

const PLATFORM_ROLES: ReadonlySet<string> = new Set<PlatformRole>([
  "platform_admin",
  "platform_support",
]);

export type DenyReason =
  | "NOT_MEMBER"
  | "ROLE_LACKS_PERMISSION"
  | "ACCOUNT_SUSPENDED"
  | "OUT_OF_SCOPE";

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason };

type Holder = Roles | PlatformRole;
// true = allowed; "scoped" = door staff only for the events they are limited to.
type Grant = true | "scoped";

const OWNER_ADMIN: Holder[] = [Roles.OWNER, Roles.ADMIN];
const OWNER_ADMIN_EVENT_MANAGER: Holder[] = [
  ...OWNER_ADMIN,
  Roles.EVENT_MANAGER,
];

function allow(holders: Holder[], extra: Partial<Record<Holder, Grant>> = {}) {
  return {
    ...Object.fromEntries(holders.map((h) => [h, true as const])),
    ...extra,
  } as Partial<Record<Holder, Grant>>;
}

const ADMIN: PlatformRole = "platform_admin";
const SUPPORT: PlatformRole = "platform_support";

const GRANTS = {
  "account.manage_team": allow([...OWNER_ADMIN, ADMIN]),
  "account.edit_profile": allow([...OWNER_ADMIN, ADMIN]),
  "event.create": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "event.edit": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "event.publish": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "event.reschedule": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "event.cancel": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "event.pricing": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "event.inventory_holds": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "event.view": allow(
    [...OWNER_ADMIN_EVENT_MANAGER, Roles.FINANCE, ADMIN, SUPPORT],
    { [Roles.DOOR_STAFF]: "scoped" },
  ),
  "orders.view": allow([
    ...OWNER_ADMIN_EVENT_MANAGER,
    Roles.FINANCE,
    ADMIN,
    SUPPORT,
  ]),
  "reports.view": allow([
    ...OWNER_ADMIN_EVENT_MANAGER,
    Roles.FINANCE,
    ADMIN,
    SUPPORT,
  ]),
  "orders.refund": allow([...OWNER_ADMIN, Roles.FINANCE, ADMIN, SUPPORT]),
  "attendance.scan": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN], {
    [Roles.DOOR_STAFF]: "scoped",
  }),
  "layout.create": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "venue.create": allow([...OWNER_ADMIN_EVENT_MANAGER, ADMIN]),
  "venue.edit_profile": allow([Roles.VENUE_MANAGER, ADMIN]),
  "venue.promote_standard_layout": allow([Roles.VENUE_MANAGER, ADMIN]),
  "venue.verify": allow([ADMIN]),
  "venue.merge": allow([ADMIN]),
  "venue.approve_claim": allow([ADMIN]),
  "account.suspend": allow([ADMIN]),
  "platform.grant_role": allow([ADMIN]),
} satisfies Record<string, Partial<Record<Holder, Grant>>>;

export type Permission = keyof typeof GRANTS;

export const PERMISSIONS = Object.keys(GRANTS) as Permission[];

export function isPermission(name: string): name is Permission {
  return Object.hasOwn(GRANTS, name);
}

// Which membership a permission is judged against.
export type PermissionTarget = "account" | "venue" | "platform";

const VENUE_PERMISSIONS: readonly Permission[] = [
  "venue.edit_profile",
  "venue.promote_standard_layout",
];
const PLATFORM_ONLY_PERMISSIONS: readonly Permission[] = [
  "venue.verify",
  "venue.merge",
  "venue.approve_claim",
  "account.suspend",
  "platform.grant_role",
];

export function permissionTarget(permission: Permission): PermissionTarget {
  if (VENUE_PERMISSIONS.includes(permission)) return "venue";
  if (PLATFORM_ONLY_PERMISSIONS.includes(permission)) return "platform";
  return "account";
}

// What a suspended account's members may still do. Events already on sale keep
// selling, so people can still look at sales and reports, ticket holders must
// still get in at the door, and buyers must still be refundable. Suspension
// blocks organizer edits and publishing, not buyer protection.
const SUSPENDED_ALLOWED: ReadonlySet<Permission> = new Set([
  "event.view",
  "orders.view",
  "reports.view",
  "attendance.scan",
  "orders.refund",
]);

export interface DecideInput {
  permission: Permission;
  // Straight from the verified request; unknown strings grant nothing.
  platformRoles: readonly string[];
  // The caller's membership on the account (or venue) the permission applies to.
  membership: { role: Roles; eventIds: readonly string[] } | null;
  accountSuspended: boolean;
  eventId?: string;
}

export function decide(input: DecideInput): Decision {
  const grants = GRANTS[input.permission];

  // A platform role grants on its own, whatever the account's state or membership.
  if (
    input.platformRoles.some(
      (r) => PLATFORM_ROLES.has(r) && grants[r as PlatformRole],
    )
  ) {
    return { allowed: true };
  }

  if (!input.membership) {
    // Someone holding a platform role has a role; it just lacks this permission.
    const hasRole =
      permissionTarget(input.permission) === "platform" ||
      input.platformRoles.some((r) => PLATFORM_ROLES.has(r));
    return {
      allowed: false,
      reason: hasRole ? "ROLE_LACKS_PERMISSION" : "NOT_MEMBER",
    };
  }

  const grant = grants[input.membership.role];
  if (!grant) return { allowed: false, reason: "ROLE_LACKS_PERMISSION" };

  if (input.accountSuspended && !SUSPENDED_ALLOWED.has(input.permission)) {
    return { allowed: false, reason: "ACCOUNT_SUSPENDED" };
  }

  // No scope rows means every event of the account.
  if (grant === "scoped" && input.membership.eventIds.length > 0) {
    if (!input.eventId || !input.membership.eventIds.includes(input.eventId)) {
      return { allowed: false, reason: "OUT_OF_SCOPE" };
    }
  }

  return { allowed: true };
}
