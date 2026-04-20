import { Resolver, Query, ResolveField, Parent, Context, ResolveReference } from '@nestjs/graphql';
import { UsersRepository } from '../modules/users/users.repository';

@Resolver('User')
export class AuthResolver {
  constructor(private readonly usersRepository: UsersRepository) {}

  @Query()
  async currentUser(@Context() ctx: any) {
    const userId = ctx.req.headers['x-user-id'];
    if (!userId) return null;
    return this.usersRepository.findById(userId);
  }

  @ResolveReference()
  async resolveReference(reference: { __typename: string; id: string }) {
    return this.usersRepository.findById(reference.id);
  }

  @ResolveField()
  email(@Parent() user: any, @Context() ctx: any) {
    const requesterId = ctx.req.headers['x-user-id'];
    if (requesterId !== user.id) return null;
    return user.email;
  }
}
