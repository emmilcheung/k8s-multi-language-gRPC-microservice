/* eslint-disable @typescript-eslint/require-await -- the fake mirrors the async repository API */
import { beforeEach, describe, expect, it } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import type { AccountsRepository } from "./accounts.repository";
import { Roles } from "./roles";

type Row = {
  id: string;
  userId: string;
  resourceType: "ORGANIZER_ACCOUNT";
  resourceId: string;
  role: Roles;
  createdBy: string;
  createdAt: Date;
};

// In-memory stand-in for the repository so the rules are tested without a database.
class FakeRepository {
  accounts: {
    id: string;
    name: string;
    personalForUserId: string | null;
    createdBy: string;
  }[] = [];
  rows: Row[] = [];
  scopes = new Map<string, string[]>();
  audited: { action: string }[] = [];
  private seq = 0;

  async audit(entry: { action: string }) {
    this.audited.push(entry);
  }

  private nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async getAccount(id: string) {
    return this.accounts.find((a) => a.id === id);
  }

  async withLockedAccount<T>(
    _id: string,
    fn: (repo: FakeRepository) => Promise<T>,
  ) {
    return fn(this);
  }

  async createAccountWithOwner(input: { name: string; createdBy: string }) {
    const account = {
      id: this.nextId("acc"),
      name: input.name,
      personalForUserId: null as string | null,
      createdBy: input.createdBy,
    };
    this.accounts.push(account);
    await this.insertMembership({
      accountId: account.id,
      userId: input.createdBy,
      role: Roles.OWNER,
      createdBy: input.createdBy,
    });
    return account;
  }

  async findProfileDisplayName(): Promise<string | undefined> {
    return undefined;
  }

  async ensurePersonalAccount(userId: string, name: string) {
    const existing = this.accounts.find((a) => a.personalForUserId === userId);
    if (existing) return existing;
    const account = await this.createAccountWithOwner({
      name,
      createdBy: userId,
    });
    account.personalForUserId = userId;
    return account;
  }

  async findMembership(accountId: string, userId: string) {
    return this.rows.find(
      (r) => r.resourceId === accountId && r.userId === userId,
    );
  }

  async countOwners(accountId: string) {
    return this.rows.filter(
      (r) => r.resourceId === accountId && r.role === Roles.OWNER,
    ).length;
  }

  async insertMembership(input: {
    accountId: string;
    userId: string;
    role: Roles;
    createdBy: string;
  }) {
    const row: Row = {
      id: this.nextId("mem"),
      userId: input.userId,
      resourceType: "ORGANIZER_ACCOUNT",
      resourceId: input.accountId,
      role: input.role,
      createdBy: input.createdBy,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async updateRole(membershipId: string, role: Roles) {
    const row = this.rows.find((r) => r.id === membershipId)!;
    row.role = role;
    return row;
  }

  async deleteMembership(membershipId: string) {
    this.rows = this.rows.filter((r) => r.id !== membershipId);
    this.scopes.delete(membershipId);
  }

  async replaceEventScopes(membershipId: string, eventIds: string[]) {
    this.scopes.set(membershipId, eventIds);
  }

  async listEventScopes(membershipId: string) {
    return this.scopes.get(membershipId) ?? [];
  }
}

describe("AccountsService", () => {
  let repo: FakeRepository;
  let service: AccountsService;
  let accountId: string;

  beforeEach(async () => {
    repo = new FakeRepository();
    service = new AccountsService(repo as unknown as AccountsRepository);
    const account = await service.createAccount({
      name: "Acme Live",
      createdBy: "owner",
    });
    accountId = account.id;
  });

  const roleOf = async (userId: string) =>
    (await repo.findMembership(accountId, userId))?.role;

  describe("an account always keeps at least one owner", () => {
    it("creating an account makes its creator the owner", async () => {
      expect(await roleOf("owner")).toBe(Roles.OWNER);
    });

    it("removing the last owner fails", async () => {
      await expect(
        service.removeMember(accountId, "owner", "owner"),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await roleOf("owner")).toBe(Roles.OWNER);
    });

    it("demoting the last owner fails", async () => {
      await expect(
        service.changeRole(accountId, "owner", "owner", Roles.ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await roleOf("owner")).toBe(Roles.OWNER);
    });

    it("an owner can step down once another owner exists", async () => {
      await service.addMember(accountId, "owner", "second", Roles.OWNER);
      await service.changeRole(accountId, "owner", "owner", Roles.ADMIN);
      expect(await roleOf("owner")).toBe(Roles.ADMIN);
      await expect(
        service.removeMember(accountId, "second", "second"),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("who may grant which role", () => {
    it("a member cannot grant a role above their own", async () => {
      await service.addMember(accountId, "owner", "admin", Roles.ADMIN);
      await expect(
        service.addMember(accountId, "admin", "x", Roles.OWNER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await service.addMember(accountId, "owner", "mgr", Roles.EVENT_MANAGER);
      await expect(
        service.changeRole(accountId, "admin", "mgr", Roles.OWNER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await roleOf("mgr")).toBe(Roles.EVENT_MANAGER);
    });

    it("an admin can grant roles up to admin", async () => {
      await service.addMember(accountId, "owner", "admin", Roles.ADMIN);
      await service.addMember(accountId, "admin", "fin", Roles.FINANCE);
      await service.changeRole(accountId, "admin", "fin", Roles.ADMIN);
      expect(await roleOf("fin")).toBe(Roles.ADMIN);
    });

    it("only an owner can create or remove another owner", async () => {
      await service.addMember(accountId, "owner", "admin", Roles.ADMIN);
      await service.addMember(accountId, "owner", "second", Roles.OWNER);
      await expect(
        service.removeMember(accountId, "admin", "second"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.changeRole(accountId, "admin", "second", Roles.ADMIN),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await service.removeMember(accountId, "owner", "second");
      expect(await roleOf("second")).toBeUndefined();
    });

    it("members who do not manage the team cannot change it", async () => {
      await service.addMember(accountId, "owner", "fin", Roles.FINANCE);
      await expect(
        service.addMember(accountId, "fin", "x", Roles.DOOR_STAFF),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.addMember(accountId, "stranger", "x", Roles.DOOR_STAFF),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("a user cannot be a member of the same account twice", async () => {
      await service.addMember(accountId, "owner", "fin", Roles.FINANCE);
      await expect(
        service.addMember(accountId, "owner", "fin", Roles.ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("an account cannot give a member the venue manager role", async () => {
      await expect(
        service.addMember(accountId, "owner", "x", Roles.VENUE_MANAGER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("door staff event limits apply only to door staff", () => {
    it("limits a door staff member to the listed events", async () => {
      await service.addMember(accountId, "owner", "door", Roles.DOOR_STAFF);
      await service.setEventScopes(accountId, "owner", "door", ["e1", "e2"]);
      const door = (await repo.findMembership(accountId, "door"))!;
      expect(await repo.listEventScopes(door.id)).toEqual(["e1", "e2"]);
    });

    it("refuses an event limit on any other role", async () => {
      await service.addMember(accountId, "owner", "mgr", Roles.EVENT_MANAGER);
      await expect(
        service.setEventScopes(accountId, "owner", "mgr", ["e1"]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("drops the event limit when the member stops being door staff", async () => {
      await service.addMember(accountId, "owner", "door", Roles.DOOR_STAFF);
      await service.setEventScopes(accountId, "owner", "door", ["e1"]);
      await service.changeRole(accountId, "owner", "door", Roles.FINANCE);
      const door = (await repo.findMembership(accountId, "door"))!;
      expect(await repo.listEventScopes(door.id)).toEqual([]);
    });
  });

  describe("personal accounts", () => {
    it("ensuring a personal account twice returns the same account", async () => {
      const first = await service.ensurePersonalAccount("u1", "Ada");
      const second = await service.ensurePersonalAccount("u1", "Renamed");
      expect(second).toBe(first);
      expect(
        repo.accounts.filter((a) => a.personalForUserId === "u1"),
      ).toHaveLength(1);
      expect(repo.accounts.find((a) => a.id === first)?.name).toBe("Ada");
    });

    it("names the account after the user, or a default when no name is known", async () => {
      const named = await service.ensurePersonalAccount("u1", "Ada");
      const anonymous = await service.ensurePersonalAccount("u2");
      expect(repo.accounts.find((a) => a.id === named)?.name).toBe("Ada");
      expect(repo.accounts.find((a) => a.id === anonymous)?.name).toBe(
        "Personal account",
      );
    });

    it("makes the user the owner of their personal account", async () => {
      const id = await service.ensurePersonalAccount("u1", "Ada");
      expect((await repo.findMembership(id, "u1"))?.role).toBe(Roles.OWNER);
    });
  });
});
