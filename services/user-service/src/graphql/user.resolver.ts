import { Resolver, ResolveField, Parent, Context, ResolveReference } from '@nestjs/graphql';
import { UserSettingsService } from '../modules/user-settings/user-settings.service';

@Resolver('User')
export class UserResolver {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @ResolveReference()
  async resolveReference(reference: { __typename: string; id: string }) {
    return { id: reference.id };
  }

  @ResolveField()
  async profile(@Parent() user: any, @Context() ctx: any) {
    if (ctx.req.headers['x-user-id'] !== user.id) return null;
    return this.userSettingsService.getProfile(user.id);
  }

  @ResolveField()
  async preferences(@Parent() user: any, @Context() ctx: any) {
    if (ctx.req.headers['x-user-id'] !== user.id) return null;
    return this.userSettingsService.getPreferences(user.id);
  }
}
