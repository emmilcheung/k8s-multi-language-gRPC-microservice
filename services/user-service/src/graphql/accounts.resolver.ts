import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import type { Request } from "express";
import type {
  Invitation,
  Membership,
  OrganizerAccount,
  VenueClaim,
} from "../database/schema";
import { PlatformRolesVerifier } from "../common/security/platform-roles.verifier";
import { AccountsService, isUuid } from "../modules/accounts/accounts.service";
import { PermissionsService } from "../modules/accounts/permissions.service";
import { VenueClaimsService } from "../modules/accounts/venue-claims.service";
import { Roles } from "../modules/accounts/roles";
import { UserIdSigGuard } from "./guards/user-id-sig.guard";

interface GqlContext {
  req: Request;
}

interface UserError {
  field: string[] | null;
  message: string;
  code: "NOT_ALLOWED" | "NOT_FOUND" | "INVALID" | "CONFLICT" | "INTERNAL";
}

// GraphQL hands the role over as its name.
type RoleName = `${Roles}`;

interface Caller {
  userId: string;
  // Only platform roles whose gateway signature verified.
  platformRoles: string[];
}

const MAX_NAME = 120;
const MAX_EVENT_IDS = 200;
const MAX_EVENT_ID = 64;
const NOT_ALLOWED = "You are not allowed to do this";
const INTERNAL = "Something went wrong. Try again.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function header(ctx: GqlContext, name: string): string | undefined {
  const value = ctx.req.headers[name];
  return typeof value === "string" ? value : undefined;
}

@Resolver()
@UseGuards(UserIdSigGuard)
export class AccountsResolver {
  private readonly logger = new Logger(AccountsResolver.name);

  constructor(
    private readonly accounts: AccountsService,
    private readonly claims: VenueClaimsService,
    private readonly permissions: PermissionsService,
    private readonly roles: PlatformRolesVerifier,
    private readonly config: ConfigService,
  ) {}

  // ---- queries ----

  @Query("myAccounts")
  async myAccounts(@Context() ctx: GqlContext) {
    const { userId } = this.caller(ctx);
    const rows = await this.accounts.listAccountsForUser(userId);
    return rows.map(({ account, role }) => ({
      account: this.toAccount(account),
      role,
    }));
  }

  @Query("account")
  async account(@Args("id") id: string, @Context() ctx: GqlContext) {
    const caller = this.caller(ctx);
    if (!isUuid(id)) return null;
    const account = await this.accounts.findAccount(id);
    if (!account) return null;
    const isStaff = caller.platformRoles.length > 0;
    if (!isStaff && !(await this.accounts.findMembership(id, caller.userId))) {
      return null;
    }
    return this.toAccount(account);
  }

  @Query("accountMembers")
  async accountMembers(
    @Args("accountId") accountId: string,
    @Context() ctx: GqlContext,
  ) {
    const caller = this.caller(ctx);
    await this.authorize(caller, "account.manage_team", accountId);
    const members = await this.accounts.listMembers(accountId);
    return members.map((m) => this.toMember(m.membership, m.eventIds));
  }

  @Query("myInvitations")
  async myInvitations(@Context() ctx: GqlContext) {
    const { userId } = this.caller(ctx);
    const sent = await this.accounts.listInvitationsSentBy(userId);
    return sent.map((i) => this.toInvitation(i));
  }

  // ---- mutations ----

  @Mutation("createOrganizerAccount")
  createOrganizerAccount(
    @Args("input") input: { name: string; contactEmail?: string | null },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const { userId } = this.caller(ctx);
        const name = input.name.trim();
        if (!name || name.length > MAX_NAME) {
          throw new BadRequestException("Enter an account name");
        }
        const contactEmail = input.contactEmail?.trim() || undefined;
        if (contactEmail && !EMAIL.test(contactEmail)) {
          throw new BadRequestException("Enter a valid contact email");
        }
        const account = await this.accounts.createAccount({
          name,
          contactEmail,
          createdBy: userId,
        });
        return { account: this.toAccount(account) };
      },
      { account: null },
    );
  }

  @Mutation("inviteMember")
  inviteMember(
    @Args("input")
    input: { accountId: string; email: string; role: RoleName },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const caller = this.caller(ctx);
        await this.authorize(caller, "account.manage_team", input.accountId);
        const { invitation, token } = await this.accounts.inviteMember(
          input.accountId,
          caller.userId,
          input.email,
          input.role as Roles,
        );
        return {
          invitation: this.toInvitation(invitation),
          acceptLink: this.acceptLink(token),
        };
      },
      { invitation: null, acceptLink: null },
    );
  }

  @Mutation("acceptInvitation")
  acceptInvitation(@Args("token") token: string, @Context() ctx: GqlContext) {
    return this.run(
      async () => {
        const { userId } = this.caller(ctx);
        const { account, role } = await this.accounts.acceptInvitation(
          token,
          userId,
        );
        return { account: this.toAccount(account), role };
      },
      { account: null, role: null },
    );
  }

  @Mutation("changeMemberRole")
  changeMemberRole(
    @Args("input")
    input: { accountId: string; userId: string; role: RoleName },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const caller = this.caller(ctx);
        await this.authorize(caller, "account.manage_team", input.accountId);
        const membership = await this.accounts.changeRole(
          input.accountId,
          caller.userId,
          input.userId,
          input.role as Roles,
        );
        return { member: this.toMember(membership, []) };
      },
      { member: null },
    );
  }

  @Mutation("removeMember")
  removeMember(
    @Args("input") input: { accountId: string; userId: string },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const caller = this.caller(ctx);
        await this.authorize(caller, "account.manage_team", input.accountId);
        await this.accounts.removeMember(
          input.accountId,
          caller.userId,
          input.userId,
        );
        return { removed: true };
      },
      { removed: false },
    );
  }

  @Mutation("setDoorStaffEvents")
  setDoorStaffEvents(
    @Args("input")
    input: { accountId: string; userId: string; eventIds: string[] },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const caller = this.caller(ctx);
        await this.authorize(caller, "account.manage_team", input.accountId);
        if (
          input.eventIds.length > MAX_EVENT_IDS ||
          input.eventIds.some((e) => !e.trim() || e.length > MAX_EVENT_ID)
        ) {
          throw new BadRequestException("Event list is not valid");
        }
        await this.accounts.setEventScopes(
          input.accountId,
          caller.userId,
          input.userId,
          input.eventIds,
        );
        const members = await this.accounts.listMembers(input.accountId);
        const updated = members.find(
          (m) => m.membership.userId === input.userId,
        );
        return {
          member:
            updated && this.toMember(updated.membership, updated.eventIds),
        };
      },
      { member: null },
    );
  }

  @Mutation("submitVenueClaim")
  submitVenueClaim(
    @Args("input")
    input: {
      venueId: string;
      accountId?: string | null;
      evidenceText?: string | null;
    },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const { userId } = this.caller(ctx);
        const claim = await this.claims.submit({
          userId,
          venueId: input.venueId,
          accountId: input.accountId ?? undefined,
          evidenceText: input.evidenceText ?? undefined,
        });
        return { claim: this.toClaim(claim) };
      },
      { claim: null },
    );
  }

  @Mutation("decideVenueClaim")
  decideVenueClaim(
    @Args("input")
    input: {
      claimId: string;
      decision: "APPROVE" | "REJECT";
      reason: string;
    },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const caller = this.caller(ctx);
        await this.authorize(caller, "venue.approve_claim");
        const claim = await this.claims.decide({
          claimId: input.claimId,
          approve: input.decision === "APPROVE",
          decidedBy: caller.userId,
          reason: input.reason,
        });
        return { claim: this.toClaim(claim) };
      },
      { claim: null },
    );
  }

  @Mutation("suspendAccount")
  suspendAccount(
    @Args("input") input: { accountId: string; reason: string },
    @Context() ctx: GqlContext,
  ) {
    return this.run(
      async () => {
        const caller = this.caller(ctx);
        await this.authorize(caller, "account.suspend");
        const reason = input.reason.trim();
        if (!reason || reason.length > 500) {
          throw new BadRequestException("Give a reason for suspending");
        }
        const account = await this.accounts.suspendAccount(
          input.accountId,
          caller.userId,
          reason,
        );
        return { account: this.toAccount(account) };
      },
      { account: null },
    );
  }

  // ---- helpers ----

  private caller(ctx: GqlContext): Caller {
    const userId = header(ctx, "x-user-id");
    if (!userId) throw new ForbiddenException("Missing X-User-Id");
    return {
      userId,
      platformRoles: this.roles.verify(
        userId,
        header(ctx, "x-user-roles"),
        header(ctx, "x-user-roles-sig"),
      ),
    };
  }

  // Every organizer and platform action goes through the one permission table.
  private async authorize(
    caller: Caller,
    permission: string,
    accountId?: string,
  ): Promise<void> {
    if (accountId !== undefined && !isUuid(accountId)) {
      throw new BadRequestException("account_id is not a valid id");
    }
    const decision = await this.permissions.check({
      userId: caller.userId,
      platformRoles: caller.platformRoles,
      permission,
      accountId,
    });
    if (!decision.allowed) throw new ForbiddenException(NOT_ALLOWED);
  }

  // Turns expected failures into userErrors; anything else is logged and
  // reported without its internal text.
  private async run<T extends object, F extends object>(
    work: () => Promise<T>,
    failed: F,
  ): Promise<(T | F) & { userErrors: UserError[] }> {
    try {
      return { ...(await work()), userErrors: [] };
    } catch (err) {
      return { ...failed, userErrors: [this.toUserError(err)] };
    }
  }

  private toUserError(err: unknown): UserError {
    const message = err instanceof Error ? err.message : "";
    if (err instanceof ForbiddenException) {
      return { field: null, message, code: "NOT_ALLOWED" };
    }
    if (err instanceof NotFoundException) {
      return { field: null, message, code: "NOT_FOUND" };
    }
    if (err instanceof BadRequestException) {
      return { field: null, message, code: "INVALID" };
    }
    if (err instanceof ConflictException) {
      return { field: null, message, code: "CONFLICT" };
    }
    // The raw message can carry query parameters (emails, token hashes), so
    // only the error type and database code are logged.
    const code = (err as { cause?: { code?: string } }).cause?.code;
    this.logger.error(
      `accounts mutation failed: ${err instanceof Error ? err.name : "unknown"}${code ? ` (${code})` : ""}`,
    );
    return { field: null, message: INTERNAL, code: "INTERNAL" };
  }

  private acceptLink(token: string): string {
    const origin = this.config.get<string>("PUBLIC_WEB_URL", "");
    return `${origin.replace(/\/$/, "")}/invitations/accept?token=${token}`;
  }

  private toAccount(a: OrganizerAccount) {
    return {
      id: a.id,
      name: a.name,
      contactEmail: a.contactEmail,
      status: a.status,
    };
  }

  private toMember(m: Membership, eventIds: string[]) {
    return {
      userId: m.userId,
      role: m.role,
      eventIds,
      joinedAt: m.createdAt.toISOString(),
    };
  }

  private toInvitation(i: Invitation) {
    const overdue =
      i.status === "PENDING" && i.expiresAt.getTime() <= Date.now();
    return {
      id: i.id,
      accountId: i.accountId,
      email: i.email,
      role: i.role,
      status: overdue ? "EXPIRED" : i.status,
      expiresAt: i.expiresAt.toISOString(),
    };
  }

  private toClaim(c: VenueClaim) {
    return {
      id: c.id,
      venueId: c.venueId,
      accountId: c.claimantAccountId,
      status: c.status,
      reason: c.reason,
    };
  }
}
