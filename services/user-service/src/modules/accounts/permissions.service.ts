import { BadRequestException, Injectable } from "@nestjs/common";
import { AccountsRepository } from "./accounts.repository";
import { isUuid } from "./accounts.service";
import {
  type Decision,
  decide,
  isPermission,
  permissionTarget,
} from "./permissions";
import type { Roles } from "./roles";

export interface CheckInput {
  userId: string;
  // Read by the caller from the verified token; never looked up here.
  platformRoles: readonly string[];
  permission: string;
  accountId?: string;
  venueId?: string;
  eventId?: string;
}

@Injectable()
export class PermissionsService {
  constructor(private readonly repository: AccountsRepository) {}

  async check(input: CheckInput): Promise<Decision> {
    if (!input.userId) throw new BadRequestException("user_id is required");
    if (!isPermission(input.permission)) {
      throw new BadRequestException(`Unknown permission: ${input.permission}`);
    }
    const permission = input.permission;
    const target = permissionTarget(permission);

    // Platform roles decide on their own, so skip the database for them.
    const platformDecision = decide({
      permission,
      platformRoles: input.platformRoles,
      membership: null,
      accountSuspended: false,
    });
    if (platformDecision.allowed) return platformDecision;

    let membership: { role: Roles; eventIds: string[] } | null = null;
    let accountSuspended = false;

    if (target === "account" && input.accountId) {
      if (!isUuid(input.accountId)) {
        throw new BadRequestException("account_id is not a valid id");
      }
      const found = await this.repository.findMembership(
        input.accountId,
        input.userId,
      );
      if (found) {
        const [account, eventIds] = await Promise.all([
          this.repository.getAccount(input.accountId),
          this.repository.listEventScopes(found.id),
        ]);
        accountSuspended = account?.status === "SUSPENDED";
        membership = { role: found.role, eventIds };
      }
    } else if (target === "venue" && input.venueId) {
      const found = await this.repository.findVenueMembership(
        input.venueId,
        input.userId,
      );
      if (found) membership = { role: found.role, eventIds: [] };
    }

    return decide({
      permission,
      platformRoles: input.platformRoles,
      membership,
      accountSuspended,
      eventId: input.eventId || undefined,
    });
  }
}
