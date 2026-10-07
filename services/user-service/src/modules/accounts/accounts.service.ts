import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import type {
  Invitation,
  Membership,
  OrganizerAccount,
} from "../../database/schema";
import { AccountsRepository } from "./accounts.repository";
import { Roles, isAccountRole, roleRank } from "./roles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const hashInvitationToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

// Invitation tokens are 43 characters; anything far longer cannot be one and is
// not worth hashing.
const MAX_INVITATION_TOKEN_LENGTH = 200;

const DEFAULT_PERSONAL_ACCOUNT_NAME = "Personal account";

@Injectable()
export class AccountsService {
  constructor(private readonly repository: AccountsRepository) {}

  createAccount(input: {
    name: string;
    contactEmail?: string;
    createdBy: string;
  }): Promise<OrganizerAccount> {
    return this.repository.createAccountWithOwner(input);
  }

  // The name is only used when the account is first created: the one passed
  // in, else the user's profile display name, else a generic one.
  async ensurePersonalAccount(
    userId: string,
    displayName?: string,
  ): Promise<string> {
    const name =
      displayName?.trim() ||
      (await this.repository.findProfileDisplayName(userId))?.trim() ||
      DEFAULT_PERSONAL_ACCOUNT_NAME;
    const account = await this.repository.ensurePersonalAccount(userId, name);
    return account.id;
  }

  ensureVenueManager(userId: string, venueId: string): Promise<void> {
    return this.repository.ensureVenueManager(userId, venueId);
  }

  async getAccount(accountId: string): Promise<OrganizerAccount> {
    if (!isUuid(accountId)) {
      throw new BadRequestException("account_id is not a valid id");
    }
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new NotFoundException("Account not found");
    return account;
  }

  listAccountsForUser(
    userId: string,
  ): Promise<{ account: OrganizerAccount; role: Roles; eventIds: string[] }[]> {
    return this.repository.listAccountsForUser(userId);
  }

  addMember(
    accountId: string,
    actorUserId: string,
    userId: string,
    role: Roles,
  ): Promise<Membership> {
    return this.repository.withLockedAccount(accountId, async (repo) => {
      const actor = await this.requireTeamManager(repo, accountId, actorUserId);
      this.requireAccountRole(role);
      this.requireCanGrant(actor.role, role);
      if (await repo.findMembership(accountId, userId)) {
        throw new ConflictException("User is already a member of this account");
      }
      const membership = await repo.insertMembership({
        accountId,
        userId,
        role,
        createdBy: actorUserId,
      });
      await repo.audit({
        actorUserId,
        actorAccountId: accountId,
        action: "membership.added",
        resource: `account:${accountId}`,
        after: { userId, role },
      });
      return membership;
    });
  }

  changeRole(
    accountId: string,
    actorUserId: string,
    userId: string,
    role: Roles,
  ): Promise<Membership> {
    return this.repository.withLockedAccount(accountId, async (repo) => {
      const actor = await this.requireTeamManager(repo, accountId, actorUserId);
      this.requireAccountRole(role);
      const target = await this.requireMember(repo, accountId, userId);
      this.requireCanGrant(actor.role, role);
      this.requireCanTouch(actor.role, target.role);
      await this.requireNotLastOwner(repo, accountId, target, role);

      const updated = await repo.updateRole(target.id, role);
      if (role !== Roles.DOOR_STAFF) {
        await repo.replaceEventScopes(target.id, []);
      }
      await repo.audit({
        actorUserId,
        actorAccountId: accountId,
        action: "membership.role_changed",
        resource: `account:${accountId}`,
        before: { userId, role: target.role },
        after: { userId, role },
      });
      return updated;
    });
  }

  removeMember(
    accountId: string,
    actorUserId: string,
    userId: string,
  ): Promise<void> {
    return this.repository.withLockedAccount(accountId, async (repo) => {
      const actor = await this.requireTeamManager(repo, accountId, actorUserId);
      const target = await this.requireMember(repo, accountId, userId);
      this.requireCanTouch(actor.role, target.role);
      await this.requireNotLastOwner(repo, accountId, target, null);

      await repo.deleteMembership(target.id);
      await repo.audit({
        actorUserId,
        actorAccountId: accountId,
        action: "membership.removed",
        resource: `account:${accountId}`,
        before: { userId, role: target.role },
      });
    });
  }

  // An empty list lifts the limit: door staff then cover every event of the account.
  setEventScopes(
    accountId: string,
    actorUserId: string,
    userId: string,
    eventIds: string[],
  ): Promise<void> {
    return this.repository.withLockedAccount(accountId, async (repo) => {
      await this.requireTeamManager(repo, accountId, actorUserId);
      const target = await this.requireMember(repo, accountId, userId);
      if (target.role !== Roles.DOOR_STAFF) {
        throw new BadRequestException(
          "Event limits apply only to door staff members",
        );
      }
      const before = await repo.listEventScopes(target.id);
      const after = [...new Set(eventIds)];
      await repo.replaceEventScopes(target.id, after);
      await repo.audit({
        actorUserId,
        actorAccountId: accountId,
        action: "membership.event_scopes_changed",
        resource: `account:${accountId}`,
        before: { userId, eventIds: before },
        after: { userId, eventIds: after },
      });
    });
  }

  async listMembers(
    accountId: string,
  ): Promise<{ membership: Membership; eventIds: string[] }[]> {
    this.requireUuid(accountId);
    return this.repository.listMembers(accountId);
  }

  async findMembership(
    accountId: string,
    userId: string,
  ): Promise<Membership | undefined> {
    this.requireUuid(accountId);
    return this.repository.findMembership(accountId, userId);
  }

  async findAccount(accountId: string): Promise<OrganizerAccount | undefined> {
    this.requireUuid(accountId);
    return this.repository.getAccount(accountId);
  }

  // The token is returned once and only its hash is stored.
  inviteMember(
    accountId: string,
    actorUserId: string,
    email: string,
    role: Roles,
  ): Promise<{ invitation: Invitation; token: string }> {
    this.requireUuid(accountId);
    const normalized = email.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL.test(normalized)) {
      throw new BadRequestException("Enter a valid email address");
    }
    return this.repository.withLockedAccount(accountId, async (repo) => {
      const actor = await this.requireTeamManager(repo, accountId, actorUserId);
      this.requireAccountRole(role);
      if (role === Roles.OWNER) {
        throw new BadRequestException(
          "Invite as another role, then make them an owner",
        );
      }
      this.requireCanGrant(actor.role, role);
      const token = randomBytes(32).toString("base64url");
      const invitation = await repo.insertInvitation({
        accountId,
        email: normalized,
        role,
        tokenHash: hashInvitationToken(token),
        createdBy: actorUserId,
      });
      await repo.audit({
        actorUserId,
        actorAccountId: accountId,
        action: "invitation.created",
        resource: `account:${accountId}`,
        after: { invitationId: invitation.id, role },
      });
      return { invitation, token };
    });
  }

  async acceptInvitation(
    token: string,
    userId: string,
  ): Promise<{ account: OrganizerAccount; role: Roles }> {
    if (token.length > MAX_INVITATION_TOKEN_LENGTH) {
      throw new NotFoundException("This invitation link is not valid");
    }
    const result = await this.repository.acceptInvitation(
      hashInvitationToken(token),
      userId,
    );
    switch (result.outcome) {
      case "NOT_FOUND":
        throw new NotFoundException("This invitation link is not valid");
      case "EXPIRED":
        throw new ConflictException("This invitation has expired");
      case "USED":
        throw new ConflictException("This invitation has already been used");
      case "ALREADY_MEMBER":
        throw new ConflictException("You are already a member of this account");
      case "SUSPENDED":
        throw new ForbiddenException(
          "This account is suspended and cannot take new members",
        );
    }
    const account = await this.repository.getAccount(
      result.invitation.accountId,
    );
    if (!account) throw new NotFoundException("Account not found");
    return { account, role: result.invitation.role as Roles };
  }

  listInvitationsSentBy(userId: string): Promise<Invitation[]> {
    return this.repository.listInvitationsCreatedBy(userId);
  }

  suspendAccount(
    accountId: string,
    actorUserId: string,
    reason: string,
  ): Promise<OrganizerAccount> {
    this.requireUuid(accountId);
    return this.repository.withLockedAccount(accountId, async (repo) => {
      const current = await repo.getAccount(accountId);
      if (!current) throw new NotFoundException("Account not found");
      if (current.status === "SUSPENDED") return current;
      const updated = await repo.setAccountStatus(accountId, "SUSPENDED");
      await repo.audit({
        actorUserId,
        action: "account.suspended",
        resource: `account:${accountId}`,
        before: { status: current.status },
        after: { status: updated.status },
        reason,
      });
      return updated;
    });
  }

  private requireUuid(accountId: string): void {
    if (!isUuid(accountId)) {
      throw new BadRequestException("account_id is not a valid id");
    }
  }

  private async requireTeamManager(
    repo: AccountsRepository,
    accountId: string,
    userId: string,
  ): Promise<Membership> {
    const membership = await repo.findMembership(accountId, userId);
    if (
      !membership ||
      (membership.role !== Roles.OWNER && membership.role !== Roles.ADMIN)
    ) {
      throw new ForbiddenException("Not allowed to manage this team");
    }
    return membership;
  }

  private async requireMember(
    repo: AccountsRepository,
    accountId: string,
    userId: string,
  ): Promise<Membership> {
    const membership = await repo.findMembership(accountId, userId);
    if (!membership) throw new NotFoundException("Member not found");
    return membership;
  }

  private requireAccountRole(role: string): void {
    if (!isAccountRole(role)) {
      throw new BadRequestException(`${role} is not an account role`);
    }
  }

  // Never above your own role; only an owner may hand out ownership.
  private requireCanGrant(actorRole: Roles, role: Roles): void {
    if (roleRank(role) > roleRank(actorRole)) {
      throw new ForbiddenException("Cannot grant a role above your own");
    }
  }

  // Changing or removing someone needs at least their rank; only an owner may touch an owner.
  private requireCanTouch(actorRole: Roles, targetRole: Roles): void {
    if (roleRank(targetRole) > roleRank(actorRole)) {
      throw new ForbiddenException(
        "Cannot change a member above your own role",
      );
    }
  }

  private async requireNotLastOwner(
    repo: AccountsRepository,
    accountId: string,
    target: Membership,
    newRole: Roles | null,
  ): Promise<void> {
    if (target.role !== Roles.OWNER || newRole === Roles.OWNER) return;
    if ((await repo.countOwners(accountId)) <= 1) {
      throw new ConflictException("An account must keep at least one owner");
    }
  }
}
