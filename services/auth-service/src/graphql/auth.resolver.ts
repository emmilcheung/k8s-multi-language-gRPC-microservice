import {
  Resolver,
  Query,
  ResolveField,
  Parent,
  Context,
  ResolveReference,
} from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import type { User } from '../modules/users/users.repository';
import { UsersRepository } from '../modules/users/users.repository';
import { UserIdSigGuard } from './guards/user-id-sig.guard';

type GqlContext = {
  req: { headers: Record<string, string | string[] | undefined> };
};

@Resolver('User')
export class AuthResolver {
  constructor(private readonly usersRepository: UsersRepository) {}

  @Query()
  @UseGuards(UserIdSigGuard)
  async currentUser(@Context() ctx: GqlContext) {
    const userId = ctx.req.headers['x-user-id'];
    if (!userId) return null;
    return this.usersRepository.findById(userId as string);
  }

  @ResolveReference()
  @UseGuards(UserIdSigGuard)
  async resolveReference(reference: { __typename: string; id: string }) {
    return this.usersRepository.findById(reference.id);
  }

  @ResolveField()
  @UseGuards(UserIdSigGuard)
  email(@Parent() user: Partial<User>, @Context() ctx: GqlContext) {
    const requesterId = ctx.req.headers['x-user-id'];
    if (requesterId !== user.id) return null;
    return user.email;
  }
}
