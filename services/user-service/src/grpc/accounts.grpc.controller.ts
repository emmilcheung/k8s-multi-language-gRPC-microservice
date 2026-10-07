import { Controller, UseFilters } from "@nestjs/common";
import { GrpcMethod } from "@nestjs/microservices";
import type { OrganizerAccount } from "../database/schema";
import { AccountsService } from "../modules/accounts/accounts.service";
import { PermissionsService } from "../modules/accounts/permissions.service";
import { BadRequestException } from "@nestjs/common";
import { GrpcExceptionFilter } from "./grpc-exception.filter";

interface CheckPermissionRequest {
  user_id: string;
  platform_roles?: string[];
  permission: string;
  account_id?: string;
  venue_id?: string;
  event_id?: string;
}

const toAccount = (a: OrganizerAccount) => ({
  id: a.id,
  name: a.name,
  status:
    a.status === "SUSPENDED"
      ? "ACCOUNT_STATUS_SUSPENDED"
      : "ACCOUNT_STATUS_ACTIVE",
});

@Controller()
@UseFilters(GrpcExceptionFilter)
export class AccountsGrpcController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly accounts: AccountsService,
  ) {}

  @GrpcMethod("AccountsService", "CheckPermission")
  async checkPermission(req: CheckPermissionRequest) {
    const decision = await this.permissions.check({
      userId: req.user_id,
      platformRoles: req.platform_roles ?? [],
      permission: req.permission,
      accountId: req.account_id,
      venueId: req.venue_id,
      eventId: req.event_id,
    });
    return decision.allowed
      ? { allowed: true, reason_code: "REASON_CODE_UNSPECIFIED" }
      : { allowed: false, reason_code: `REASON_CODE_${decision.reason}` };
  }

  @GrpcMethod("AccountsService", "ListMyAccounts")
  async listMyAccounts(req: { user_id: string }) {
    if (!req.user_id) throw new BadRequestException("user_id is required");
    const rows = await this.accounts.listAccountsForUser(req.user_id);
    return {
      accounts: rows.map(({ account, role }) => ({
        account: toAccount(account),
        role,
      })),
    };
  }

  @GrpcMethod("AccountsService", "GetAccount")
  async getAccount(req: { account_id: string }) {
    return {
      account: toAccount(await this.accounts.getAccount(req.account_id)),
    };
  }

  @GrpcMethod("AccountsService", "EnsurePersonalAccount")
  async ensurePersonalAccount(req: { user_id: string; display_name?: string }) {
    if (!req.user_id) throw new BadRequestException("user_id is required");
    return {
      account_id: await this.accounts.ensurePersonalAccount(
        req.user_id,
        req.display_name,
      ),
    };
  }
}
