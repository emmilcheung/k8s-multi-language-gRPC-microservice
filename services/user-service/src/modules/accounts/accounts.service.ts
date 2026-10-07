import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Membership, OrganizerAccount } from "../../database/schema";
import { AccountsRepository } from "./accounts.repository";
import { Roles, isAccountRole, roleRank } from "./roles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

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
  ): Promise<{ account: OrganizerAccount; role: Roles }[]> {
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
      return repo.insertMembership({
        accountId,
        userId,
        role,
        createdBy: actorUserId,
      });
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
      await repo.replaceEventScopes(target.id, [...new Set(eventIds)]);
    });
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
