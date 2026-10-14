import { describe, expect, it } from "vitest";
import { decide, PERMISSIONS, type Decision } from "./permissions";
import { Roles } from "./roles";

// The permission table from the ticketing domain model, one row per
// permission. Written out independently of the implementation so that a
// change to a single cell makes exactly one case here fail.
// Y = allowed, s = allowed only for the events the member is limited to, . = denied.
const COLUMNS = [
  "OWNER",
  "ADMIN",
  "EVENT_MANAGER",
  "FINANCE",
  "DOOR_STAFF",
  "VENUE_MANAGER",
  "platform_admin",
  "platform_support",
] as const;

const TABLE: Record<string, string> = {
  //                        OWN ADM EVM FIN DOR VEN PAD PSU
  "account.manage_team": "Y Y . . . . Y .",
  "account.edit_profile": "Y Y . . . . Y .",
  "event.create": "Y Y Y . . . Y .",
  "event.edit": "Y Y Y . . . Y .",
  "event.publish": "Y Y Y . . . Y .",
  "event.reschedule": "Y Y Y . . . Y .",
  "event.cancel": "Y Y Y . . . Y .",
  "event.pricing": "Y Y Y . . . Y .",
  "event.inventory_holds": "Y Y Y . . . Y .",
  "event.view": "Y Y Y Y s . Y Y",
  "orders.view": "Y Y Y Y . . Y Y",
  "reports.view": "Y Y Y Y . . Y Y",
  "orders.refund": "Y Y . Y . . Y Y",
  "attendance.scan": "Y Y Y . s . Y .",
  "layout.create": "Y Y Y . . . Y .",
  "venue.create": "Y Y Y . . . Y .",
  "venue.edit_profile": ". . . . . Y Y .",
  "venue.promote_standard_layout": ". . . . . Y Y .",
  "venue.verify": ". . . . . . Y .",
  "venue.merge": ". . . . . . Y .",
  "venue.approve_claim": ". . . . . . Y .",
  "account.suspend": ". . . . . . Y .",
  "platform.grant_role": ". . . . . . Y .",
};

const cases = Object.entries(TABLE).flatMap(([permission, row]) =>
  row.split(" ").map((cell, i) => ({
    permission,
    column: COLUMNS[i],
    cell,
  })),
);

function check(
  permission: string,
  column: (typeof COLUMNS)[number],
  extra: { eventIds?: string[]; eventId?: string } = {},
): Decision {
  const isPlatform = column.startsWith("platform_");
  return decide({
    permission: permission as never,
    platformRoles: isPlatform ? [column] : [],
    membership: isPlatform
      ? null
      : {
          role: Roles[column as keyof typeof Roles],
          eventIds: extra.eventIds ?? [],
        },
    accountSuspended: false,
    eventId: extra.eventId,
  });
}

describe("permission table", () => {
  it("covers every permission the service accepts, and nothing else", () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(TABLE).sort());
  });

  it.each(cases)(
    "$column $permission: $cell",
    ({ permission, column, cell }) => {
      const decision = check(permission, column);
      expect(decision.allowed).toBe(cell !== ".");
      if (!decision.allowed) {
        expect(decision.reason).toBe("ROLE_LACKS_PERMISSION");
      }
    },
  );
});

describe("door staff limited to listed events", () => {
  const scopedPermissions = ["event.view", "attendance.scan"];

  it.each(scopedPermissions)(
    "door staff with no limit can use %s on any event of the account",
    (permission) => {
      expect(
        check(permission, "DOOR_STAFF", { eventIds: [], eventId: "e9" })
          .allowed,
      ).toBe(true);
      expect(check(permission, "DOOR_STAFF", { eventIds: [] }).allowed).toBe(
        true,
      );
    },
  );

  it.each(scopedPermissions)(
    "door staff limited to listed events can use %s on a listed event",
    (permission) => {
      const decision = check(permission, "DOOR_STAFF", {
        eventIds: ["e1", "e2"],
        eventId: "e2",
      });
      expect(decision).toEqual({ allowed: true });
    },
  );

  it.each(scopedPermissions)(
    "door staff limited to listed events cannot use %s on another event",
    (permission) => {
      expect(
        check(permission, "DOOR_STAFF", { eventIds: ["e1"], eventId: "e2" }),
      ).toEqual({ allowed: false, reason: "OUT_OF_SCOPE" });
    },
  );

  it("door staff limited to listed events is refused when the request names no event", () => {
    expect(
      check("attendance.scan", "DOOR_STAFF", { eventIds: ["e1"] }),
    ).toEqual({ allowed: false, reason: "OUT_OF_SCOPE" });
  });

  it("the event limit never narrows anyone but door staff", () => {
    expect(
      check("event.view", "FINANCE", { eventIds: ["e1"], eventId: "e2" })
        .allowed,
    ).toBe(true);
  });
});

describe("suspended account", () => {
  const suspended = (permission: string, role: Roles = Roles.OWNER) =>
    decide({
      permission: permission as never,
      platformRoles: [],
      membership: { role, eventIds: [] },
      accountSuspended: true,
    });

  it("a suspended account can view but cannot edit or publish", () => {
    for (const view of ["event.view", "orders.view", "reports.view"]) {
      expect(suspended(view).allowed, view).toBe(true);
    }
    for (const change of ["event.edit", "event.publish", "event.create"]) {
      expect(suspended(change), change).toEqual({
        allowed: false,
        reason: "ACCOUNT_SUSPENDED",
      });
    }
  });

  it("a suspended account still lets ticket holders in and buyers be refunded", () => {
    for (const keepsWorking of ["attendance.scan", "orders.refund"]) {
      expect(suspended(keepsWorking).allowed, keepsWorking).toBe(true);
    }
    expect(suspended("event.reschedule").allowed).toBe(false);
  });

  it("a suspended account's member whose role lacks the permission is told so, not that the account is suspended", () => {
    expect(suspended("event.edit", Roles.FINANCE)).toEqual({
      allowed: false,
      reason: "ROLE_LACKS_PERMISSION",
    });
  });

  it("platform staff can still act on a suspended account", () => {
    expect(
      decide({
        permission: "event.edit",
        platformRoles: ["platform_admin"],
        membership: null,
        accountSuspended: true,
      }),
    ).toEqual({ allowed: true });
  });
});

describe("who may be allowed", () => {
  it("a user with no membership and no platform role is not a member", () => {
    expect(
      decide({
        permission: "event.edit",
        platformRoles: [],
        membership: null,
        accountSuspended: false,
      }),
    ).toEqual({ allowed: false, reason: "NOT_MEMBER" });
  });

  it("a platform role grants without any membership", () => {
    expect(
      decide({
        permission: "orders.refund",
        platformRoles: ["platform_support"],
        membership: null,
        accountSuspended: false,
      }),
    ).toEqual({ allowed: true });
  });

  it("an unknown platform role string grants nothing", () => {
    expect(
      decide({
        permission: "venue.verify",
        platformRoles: ["platform_god", "OWNER"],
        membership: null,
        accountSuspended: false,
      }),
    ).toEqual({ allowed: false, reason: "ROLE_LACKS_PERMISSION" });
  });

  it("platform-only permissions are never granted by a membership", () => {
    expect(
      decide({
        permission: "account.suspend",
        platformRoles: [],
        membership: { role: Roles.OWNER, eventIds: [] },
        accountSuspended: false,
      }),
    ).toEqual({ allowed: false, reason: "ROLE_LACKS_PERMISSION" });
  });
});

describe("platform roles in a request", () => {
  it("an account role name sent as a platform role grants nothing", () => {
    expect(
      decide({
        permission: "event.edit",
        platformRoles: ["OWNER", "__proto__", "constructor"],
        membership: null,
        accountSuspended: false,
      }),
    ).toEqual({ allowed: false, reason: "NOT_MEMBER" });
  });
});
