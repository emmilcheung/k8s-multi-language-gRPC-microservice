import { describe, expect, it, vi } from "vitest";
import type { AccountsRepository } from "./accounts.repository";
import { PermissionsService } from "./permissions.service";
import { Roles } from "./roles";

function setup(opts: {
  accountMembership?: { id: string; role: Roles };
  venueMembership?: { id: string; role: Roles };
  status?: "ACTIVE" | "SUSPENDED";
  scopes?: string[];
}) {
  const repo = {
    getAccount: vi.fn(() =>
      Promise.resolve({ id: "a1", status: opts.status ?? "ACTIVE" }),
    ),
    findMembership: vi.fn(() => Promise.resolve(opts.accountMembership)),
    findVenueMembership: vi.fn(() => Promise.resolve(opts.venueMembership)),
    listEventScopes: vi.fn(() => Promise.resolve(opts.scopes ?? [])),
  };
  return {
    repo,
    service: new PermissionsService(repo as unknown as AccountsRepository),
  };
}

const A1 = "11111111-1111-4111-8111-111111111111";
const base = { userId: "u1", platformRoles: [] as string[] };

describe("PermissionsService", () => {
  it("platform roles are taken only from the request, never looked up", async () => {
    const { service, repo } = setup({});

    const granted = await service.check({
      ...base,
      platformRoles: ["platform_admin"],
      permission: "venue.verify",
    });
    expect(granted).toEqual({ allowed: true });
    expect(Object.values(repo).every((fn) => fn.mock.calls.length === 0)).toBe(
      true,
    );

    // The same user without the role in the request is denied, whatever the
    // database might say about them elsewhere.
    const denied = await service.check({ ...base, permission: "venue.verify" });
    expect(denied.allowed).toBe(false);
  });

  it("a member of the account is judged by their role on that account", async () => {
    const { service } = setup({
      accountMembership: { id: "m1", role: Roles.EVENT_MANAGER },
    });
    expect(
      await service.check({
        ...base,
        permission: "event.publish",
        accountId: A1,
      }),
    ).toEqual({ allowed: true });
    expect(
      await service.check({
        ...base,
        permission: "orders.refund",
        accountId: A1,
      }),
    ).toEqual({ allowed: false, reason: "ROLE_LACKS_PERMISSION" });
  });

  it("someone who is not on the account's team is not a member", async () => {
    const { service } = setup({});
    expect(
      await service.check({ ...base, permission: "event.view", accountId: A1 }),
    ).toEqual({ allowed: false, reason: "NOT_MEMBER" });
  });

  it("an account permission asked without an account is refused as not a member", async () => {
    const { service } = setup({
      accountMembership: { id: "m1", role: Roles.OWNER },
    });
    expect(await service.check({ ...base, permission: "event.edit" })).toEqual({
      allowed: false,
      reason: "NOT_MEMBER",
    });
  });

  it("a suspended account can view but cannot edit or publish", async () => {
    const { service } = setup({
      accountMembership: { id: "m1", role: Roles.OWNER },
      status: "SUSPENDED",
    });
    expect(
      await service.check({ ...base, permission: "event.view", accountId: A1 }),
    ).toEqual({ allowed: true });
    for (const permission of ["event.edit", "event.publish"]) {
      expect(
        await service.check({ ...base, permission, accountId: A1 }),
      ).toEqual({ allowed: false, reason: "ACCOUNT_SUSPENDED" });
    }
  });

  it("door staff limited to listed events cannot scan at another event", async () => {
    const { service } = setup({
      accountMembership: { id: "m1", role: Roles.DOOR_STAFF },
      scopes: ["e1"],
    });
    const scan = (eventId: string) =>
      service.check({
        ...base,
        permission: "attendance.scan",
        accountId: A1,
        eventId,
      });
    expect(await scan("e1")).toEqual({ allowed: true });
    expect(await scan("e2")).toEqual({
      allowed: false,
      reason: "OUT_OF_SCOPE",
    });
  });

  it("venue team permissions follow the venue membership, not account roles", async () => {
    const { service } = setup({
      accountMembership: { id: "m1", role: Roles.OWNER },
      venueMembership: { id: "m2", role: Roles.VENUE_MANAGER },
    });
    expect(
      await service.check({
        ...base,
        permission: "venue.edit_profile",
        venueId: "v1",
      }),
    ).toEqual({ allowed: true });

    const { service: outsider } = setup({
      accountMembership: { id: "m1", role: Roles.OWNER },
    });
    expect(
      await outsider.check({
        ...base,
        permission: "venue.edit_profile",
        venueId: "v1",
      }),
    ).toEqual({ allowed: false, reason: "NOT_MEMBER" });
  });

  it("rejects an account id that is not an id instead of querying with it", async () => {
    const { service, repo } = setup({});
    await expect(
      service.check({
        ...base,
        permission: "event.view",
        accountId: "not-a-uuid",
      }),
    ).rejects.toThrow(/account_id/);
    expect(repo.findMembership).not.toHaveBeenCalled();
  });

  it("rejects a permission name that is not in the table instead of guessing", async () => {
    const { service } = setup({});
    await expect(
      service.check({ ...base, permission: "event.destroy", accountId: A1 }),
    ).rejects.toThrow(/unknown permission/i);
  });
});
