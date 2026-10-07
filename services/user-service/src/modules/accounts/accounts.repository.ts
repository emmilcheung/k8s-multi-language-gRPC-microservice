import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, sql } from "drizzle-orm";
import {
  type Membership,
  type OrganizerAccount,
  membershipEventScopes,
  memberships,
  organizerAccounts,
} from "../../database/schema";
import { DRIZZLE_DB, type DrizzleDB } from "../../database/database.module";
import { Roles } from "./roles";

const ACCOUNT = "ORGANIZER_ACCOUNT" as const;
const VENUE = "VENUE" as const;

@Injectable()
export class AccountsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async getAccount(accountId: string): Promise<OrganizerAccount | undefined> {
    const [account] = await this.db
      .select()
      .from(organizerAccounts)
      .where(eq(organizerAccounts.id, accountId))
      .limit(1);
    return account;
  }

  async findMembership(
    accountId: string,
    userId: string,
  ): Promise<Membership | undefined> {
    const [membership] = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.resourceType, ACCOUNT),
          eq(memberships.resourceId, accountId),
        ),
      )
      .limit(1);
    return membership;
  }

  async findVenueMembership(
    venueId: string,
    userId: string,
  ): Promise<Membership | undefined> {
    const [membership] = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.resourceType, VENUE),
          eq(memberships.resourceId, venueId),
        ),
      )
      .limit(1);
    return membership;
  }

  listMembershipsForUser(userId: string): Promise<Membership[]> {
    return this.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId));
  }

  async listAccountsForUser(
    userId: string,
  ): Promise<{ account: OrganizerAccount; role: Roles }[]> {
    const rows = await this.db
      .select({ account: organizerAccounts, role: memberships.role })
      .from(memberships)
      .innerJoin(
        organizerAccounts,
        eq(sql`${memberships.resourceId}`, sql`${organizerAccounts.id}::text`),
      )
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.resourceType, ACCOUNT),
        ),
      )
      .orderBy(organizerAccounts.createdAt, organizerAccounts.id);
    return rows;
  }

  async listEventScopes(membershipId: string): Promise<string[]> {
    const rows = await this.db
      .select({ eventId: membershipEventScopes.eventId })
      .from(membershipEventScopes)
      .where(eq(membershipEventScopes.membershipId, membershipId));
    return rows.map((r) => r.eventId);
  }

  async countOwners(accountId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.resourceType, ACCOUNT),
          eq(memberships.resourceId, accountId),
          eq(memberships.role, Roles.OWNER),
        ),
      );
    return row.n;
  }

  async insertMembership(input: {
    accountId: string;
    userId: string;
    role: Roles;
    createdBy: string;
  }): Promise<Membership> {
    const [membership] = await this.db
      .insert(memberships)
      .values({
        userId: input.userId,
        resourceType: ACCOUNT,
        resourceId: input.accountId,
        role: input.role,
        createdBy: input.createdBy,
      })
      .returning();
    return membership;
  }

  async updateRole(membershipId: string, role: Roles): Promise<Membership> {
    const [membership] = await this.db
      .update(memberships)
      .set({ role })
      .where(eq(memberships.id, membershipId))
      .returning();
    return membership;
  }

  async deleteMembership(membershipId: string): Promise<void> {
    await this.db.delete(memberships).where(eq(memberships.id, membershipId));
  }

  async replaceEventScopes(
    membershipId: string,
    eventIds: string[],
  ): Promise<void> {
    await this.db
      .delete(membershipEventScopes)
      .where(eq(membershipEventScopes.membershipId, membershipId));
    if (eventIds.length > 0) {
      await this.db
        .insert(membershipEventScopes)
        .values(eventIds.map((eventId) => ({ membershipId, eventId })));
    }
  }

  async createAccountWithOwner(input: {
    name: string;
    contactEmail?: string;
    createdBy: string;
  }): Promise<OrganizerAccount> {
    return this.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(organizerAccounts)
        .values({
          name: input.name,
          contactEmail: input.contactEmail,
          createdBy: input.createdBy,
        })
        .returning();
      await tx.insert(memberships).values({
        userId: input.createdBy,
        resourceType: ACCOUNT,
        resourceId: account.id,
        role: Roles.OWNER,
        createdBy: input.createdBy,
      });
      return account;
    });
  }

  // Race-safe: the partial unique index lets exactly one concurrent caller
  // create the account; the others read it back.
  async ensurePersonalAccount(
    userId: string,
    name: string,
  ): Promise<OrganizerAccount> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizerAccounts)
        .values({ name, personalForUserId: userId, createdBy: userId })
        .onConflictDoNothing({
          target: organizerAccounts.personalForUserId,
          where: sql`personal_for_user_id IS NOT NULL`,
        })
        .returning();

      if (created) {
        await tx.insert(memberships).values({
          userId,
          resourceType: ACCOUNT,
          resourceId: created.id,
          role: Roles.OWNER,
          createdBy: userId,
        });
        return created;
      }

      const [existing] = await tx
        .select()
        .from(organizerAccounts)
        .where(eq(organizerAccounts.personalForUserId, userId))
        .limit(1);
      return existing;
    });
  }

  // Serialises team changes per account: the account row is locked for the
  // whole transaction, so two concurrent changes cannot both pass the
  // "keeps at least one owner" check.
  async withLockedAccount<T>(
    accountId: string,
    fn: (repo: AccountsRepository) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: organizerAccounts.id })
        .from(organizerAccounts)
        .where(eq(organizerAccounts.id, accountId))
        .for("update");
      if (!locked) throw new NotFoundException("Account not found");
      return fn(new AccountsRepository(tx as unknown as DrizzleDB));
    });
  }
}
