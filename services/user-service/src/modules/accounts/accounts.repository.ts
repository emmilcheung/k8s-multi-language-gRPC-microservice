import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type Invitation,
  type Membership,
  type OrganizerAccount,
  type VenueClaim,
  invitations,
  membershipEventScopes,
  memberships,
  organizerAccounts,
  userProfiles,
  venueClaims,
} from "../../database/schema";
import { type AuditEntry, record } from "../audit/audit";
import { DRIZZLE_DB, type DrizzleDB } from "../../database/database.module";
import { Roles } from "./roles";

const ACCOUNT = "ORGANIZER_ACCOUNT" as const;
const VENUE = "VENUE" as const;
const SYSTEM_ACTOR = "system";

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

  // Joins the open transaction when called on a repository from withLockedAccount.
  audit(entry: AuditEntry): Promise<void> {
    return record(this.db, entry);
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
  ): Promise<{ account: OrganizerAccount; role: Roles; eventIds: string[] }[]> {
    const rows = await this.db
      .select({
        account: organizerAccounts,
        role: memberships.role,
        membershipId: memberships.id,
      })
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
    if (rows.length === 0) return [];
    const scopes = await this.db
      .select()
      .from(membershipEventScopes)
      .where(
        inArray(
          membershipEventScopes.membershipId,
          rows.map((r) => r.membershipId),
        ),
      );
    return rows.map(({ account, role, membershipId }) => ({
      account,
      role,
      eventIds: scopes
        .filter((s) => s.membershipId === membershipId)
        .map((s) => s.eventId),
    }));
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
      await record(tx, {
        actorUserId: input.createdBy,
        actorAccountId: account.id,
        action: "account.created",
        resource: `account:${account.id}`,
        after: { name: account.name },
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

  async listMembers(
    accountId: string,
  ): Promise<{ membership: Membership; eventIds: string[] }[]> {
    const members = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.resourceType, ACCOUNT),
          eq(memberships.resourceId, accountId),
        ),
      )
      .orderBy(memberships.createdAt, memberships.id);
    if (members.length === 0) return [];
    const scopes = await this.db
      .select()
      .from(membershipEventScopes)
      .where(
        inArray(
          membershipEventScopes.membershipId,
          members.map((m) => m.id),
        ),
      );
    return members.map((membership) => ({
      membership,
      eventIds: scopes
        .filter((s) => s.membershipId === membership.id)
        .map((s) => s.eventId),
    }));
  }

  async setAccountStatus(
    accountId: string,
    status: "ACTIVE" | "SUSPENDED",
  ): Promise<OrganizerAccount> {
    const [account] = await this.db
      .update(organizerAccounts)
      .set({ status })
      .where(eq(organizerAccounts.id, accountId))
      .returning();
    return account;
  }

  async insertInvitation(input: {
    accountId: string;
    email: string;
    role: Roles;
    tokenHash: string;
    createdBy: string;
  }): Promise<Invitation> {
    const [invitation] = await this.db
      .insert(invitations)
      .values(input)
      .returning();
    return invitation;
  }

  listInvitationsCreatedBy(userId: string): Promise<Invitation[]> {
    return this.db
      .select()
      .from(invitations)
      .where(eq(invitations.createdBy, userId))
      .orderBy(desc(invitations.createdAt), invitations.id);
  }

  // The invitation row is locked, so two people opening the same link cannot
  // both get in. An overdue invitation is marked expired and left unused.
  async acceptInvitation(
    tokenHash: string,
    userId: string,
  ): Promise<
    | { outcome: "ACCEPTED"; invitation: Invitation }
    | {
        outcome:
          | "NOT_FOUND"
          | "USED"
          | "EXPIRED"
          | "ALREADY_MEMBER"
          | "SUSPENDED";
      }
  > {
    return this.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .for("update");
      if (!invitation) return { outcome: "NOT_FOUND" as const };
      if (invitation.status === "EXPIRED") {
        return { outcome: "EXPIRED" as const };
      }
      if (invitation.status !== "PENDING") return { outcome: "USED" as const };
      if (invitation.expiresAt.getTime() <= Date.now()) {
        await tx
          .update(invitations)
          .set({ status: "EXPIRED" })
          .where(eq(invitations.id, invitation.id));
        return { outcome: "EXPIRED" as const };
      }

      const txRepo = new AccountsRepository(tx as unknown as DrizzleDB);
      const account = await txRepo.getAccount(invitation.accountId);
      if (account?.status === "SUSPENDED") {
        return { outcome: "SUSPENDED" as const };
      }
      if (await txRepo.findMembership(invitation.accountId, userId)) {
        return { outcome: "ALREADY_MEMBER" as const };
      }
      const membership = await txRepo.insertMembership({
        accountId: invitation.accountId,
        userId,
        role: invitation.role as Roles,
        createdBy: invitation.createdBy,
      });
      await tx
        .update(invitations)
        .set({ status: "ACCEPTED", acceptedBy: userId })
        .where(eq(invitations.id, invitation.id));
      await record(tx, {
        actorUserId: userId,
        actorAccountId: invitation.accountId,
        action: "invitation.accepted",
        resource: `account:${invitation.accountId}`,
        after: {
          invitationId: invitation.id,
          membershipId: membership.id,
          userId,
          role: invitation.role,
        },
      });
      return { outcome: "ACCEPTED" as const, invitation };
    });
  }

  async insertVenueClaim(input: {
    venueId: string;
    claimantUserId: string;
    claimantAccountId?: string;
    evidenceText?: string;
  }): Promise<VenueClaim> {
    return this.db.transaction(async (tx) => {
      const [claim] = await tx.insert(venueClaims).values(input).returning();
      await record(tx, {
        actorUserId: input.claimantUserId,
        actorAccountId: input.claimantAccountId,
        action: "venue_claim.submitted",
        resource: `venue:${input.venueId}`,
        after: { claimId: claim.id, status: claim.status },
      });
      return claim;
    });
  }

  async findPendingClaim(
    venueId: string,
    claimantUserId: string,
  ): Promise<VenueClaim | undefined> {
    const [claim] = await this.db
      .select()
      .from(venueClaims)
      .where(
        and(
          eq(venueClaims.venueId, venueId),
          eq(venueClaims.claimantUserId, claimantUserId),
          eq(venueClaims.status, "PENDING"),
        ),
      )
      .limit(1);
    return claim;
  }

  // Approval and the venue manager membership commit together.
  async decideVenueClaim(input: {
    claimId: string;
    approve: boolean;
    decidedBy: string;
    reason: string;
  }): Promise<
    | { outcome: "DECIDED"; claim: VenueClaim }
    | { outcome: "NOT_FOUND" | "DECIDED_ALREADY" }
  > {
    return this.db.transaction(async (tx) => {
      const [claim] = await tx
        .select()
        .from(venueClaims)
        .where(eq(venueClaims.id, input.claimId))
        .for("update");
      if (!claim) return { outcome: "NOT_FOUND" as const };
      if (claim.status !== "PENDING") {
        return { outcome: "DECIDED_ALREADY" as const };
      }
      const status = input.approve
        ? ("APPROVED" as const)
        : ("REJECTED" as const);
      const [decided] = await tx
        .update(venueClaims)
        .set({ status, decidedBy: input.decidedBy, reason: input.reason })
        .where(eq(venueClaims.id, claim.id))
        .returning();
      if (input.approve) {
        await new AccountsRepository(
          tx as unknown as DrizzleDB,
        ).ensureVenueManager(claim.claimantUserId, claim.venueId);
      }
      await record(tx, {
        actorUserId: input.decidedBy,
        action: "venue_claim.decided",
        resource: `venue:${claim.venueId}`,
        before: { status: claim.status },
        after: {
          claimId: claim.id,
          status,
          claimantUserId: claim.claimantUserId,
        },
        reason: input.reason,
      });
      return { outcome: "DECIDED" as const, claim: decided };
    });
  }

  async findProfileDisplayName(userId: string): Promise<string | undefined> {
    const [profile] = await this.db
      .select({ displayName: userProfiles.displayName })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    return profile?.displayName ?? undefined;
  }

  // Idempotent: an existing membership on the venue, whatever its role, is
  // left alone and writes no audit row.
  async ensureVenueManager(userId: string, venueId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(memberships)
        .values({
          userId,
          resourceType: VENUE,
          resourceId: venueId,
          role: Roles.VENUE_MANAGER,
          createdBy: SYSTEM_ACTOR,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return;
      await record(tx, {
        actorUserId: SYSTEM_ACTOR,
        action: "venue.manager_ensured",
        resource: `venue:${venueId}`,
        after: { userId, role: Roles.VENUE_MANAGER },
      });
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
