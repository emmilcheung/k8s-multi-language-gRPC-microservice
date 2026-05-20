import {
  Resolver,
  ResolveField,
  Parent,
  Context,
  ResolveReference,
  Mutation,
  Args,
} from "@nestjs/graphql";
import { UseGuards, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { UserSettingsService } from "../modules/user-settings/user-settings.service";
import { UserLoader } from "./users.loader";
import { UserIdSigGuard } from "./guards/user-id-sig.guard";
import {
  UpdateBillingAddressDto,
  UpdatePreferencesDto,
  UpdateProfileDto,
} from "../modules/user-settings/user-settings.dto";

interface GqlContext {
  req: Request;
}

function requireUserId(ctx: GqlContext): string {
  const userId = ctx.req.headers["x-user-id"];
  if (typeof userId !== "string" || userId.length === 0) {
    throw new ForbiddenException("Missing X-User-Id");
  }
  return userId;
}

@Resolver("User")
export class UserResolver {
  constructor(
    private readonly userSettingsService: UserSettingsService,
    private readonly userLoader: UserLoader,
  ) {}

  @ResolveReference()
  @UseGuards(UserIdSigGuard)
  resolveReference(reference: {
    __typename: string;
    id: string;
  }): Promise<{ id: string }> {
    return this.userLoader.load(reference.id);
  }

  @ResolveField()
  @UseGuards(UserIdSigGuard)
  async profile(@Parent() user: { id: string }, @Context() ctx: GqlContext) {
    if (ctx.req.headers["x-user-id"] !== user.id) return null;
    return this.userSettingsService.getProfile(user.id);
  }

  @ResolveField()
  @UseGuards(UserIdSigGuard)
  async preferences(
    @Parent() user: { id: string },
    @Context() ctx: GqlContext,
  ) {
    if (ctx.req.headers["x-user-id"] !== user.id) return null;
    return this.userSettingsService.getPreferences(user.id);
  }

  @ResolveField()
  @UseGuards(UserIdSigGuard)
  async billingAddress(
    @Parent() user: { id: string },
    @Context() ctx: GqlContext,
  ) {
    if (ctx.req.headers["x-user-id"] !== user.id) return null;
    return this.userSettingsService.getBillingAddress(user.id);
  }
}

@Resolver()
export class UserSettingsMutationResolver {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @Mutation("updateProfile")
  @UseGuards(UserIdSigGuard)
  updateProfile(
    @Args("input") input: UpdateProfileDto,
    @Context() ctx: GqlContext,
  ) {
    return this.userSettingsService.updateProfile(requireUserId(ctx), input);
  }

  @Mutation("updatePreferences")
  @UseGuards(UserIdSigGuard)
  updatePreferences(
    @Args("input") input: UpdatePreferencesDto,
    @Context() ctx: GqlContext,
  ) {
    return this.userSettingsService.updatePreferences(
      requireUserId(ctx),
      input,
    );
  }

  @Mutation("updateBillingAddress")
  @UseGuards(UserIdSigGuard)
  updateBillingAddress(
    @Args("input") input: UpdateBillingAddressDto,
    @Context() ctx: GqlContext,
  ) {
    return this.userSettingsService.updateBillingAddress(
      requireUserId(ctx),
      input,
    );
  }
}

// Resolves UserProfile.billingAddress so existing `user.profile.billingAddress`
// selections continue to work alongside the new `user.billingAddress` field.
@Resolver("UserProfile")
export class UserProfileResolver {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @ResolveField()
  @UseGuards(UserIdSigGuard)
  async billingAddress(@Context() ctx: GqlContext) {
    const userId = ctx.req.headers["x-user-id"];
    if (typeof userId !== "string" || userId.length === 0) return null;
    return this.userSettingsService.getBillingAddress(userId);
  }
}
