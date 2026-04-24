import {
  Resolver,
  ResolveField,
  Parent,
  Context,
  ResolveReference,
} from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { UserSettingsService } from "../modules/user-settings/user-settings.service";
import { UserLoader } from "./users.loader";
import { UserIdSigGuard } from "./guards/user-id-sig.guard";

interface GqlContext {
  req: Request;
}

@Resolver("User")
export class UserResolver {
  constructor(
    private readonly userSettingsService: UserSettingsService,
    private readonly userLoader: UserLoader,
  ) {}

  @ResolveReference()
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
}
