import {
  Resolver,
  Query,
  Mutation,
  Args,
  ResolveField,
  Parent,
  Context,
  ResolveReference,
} from '@nestjs/graphql';
import { UseGuards, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '../modules/users/users.repository';
import { UsersRepository } from '../modules/users/users.repository';
import { RefreshTokenService } from '../modules/auth/refresh-token.service';
import { AuthService } from '../modules/auth/auth.service';
import { UserIdSigGuard } from './guards/user-id-sig.guard';

const DEFAULT_REFRESH_TOKEN_COOKIE = 'refreshToken';

type GqlContext = {
  req: {
    headers: Record<string, string | string[] | undefined>;
    cookies?: Record<string, string | undefined>;
  };
};

function requireUserId(ctx: GqlContext): string {
  const userId = ctx.req.headers['x-user-id'];
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ForbiddenException('Missing X-User-Id');
  }
  return userId;
}


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

@Resolver()
export class SessionResolver {
  constructor(
    private readonly refreshTokenService: RefreshTokenService,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Query('sessions')
  @UseGuards(UserIdSigGuard)
  async sessions(@Context() ctx: GqlContext) {
    const userId = requireUserId(ctx);
    const cookieName = this.config.get<string>(
      'REFRESH_COOKIE_NAME',
      DEFAULT_REFRESH_TOKEN_COOKIE,
    );
    const currentSessionId = this.refreshTokenService.extractSessionId(
      ctx.req.cookies?.[cookieName],
    );
    const sessions = await this.refreshTokenService.listSessions(userId);
    return sessions.map((s) => ({
      id: s.sessionId,
      userAgent: s.userAgent ?? null,
      ipAddress: s.ipAddress ?? null,
      createdAt: s.createdAt,
      lastUsedAt: s.lastRotatedAt,
      current: s.sessionId === currentSessionId,
    }));
  }

  @Query('userLookup')
  @UseGuards(UserIdSigGuard)
  async userLookup(
    @Args('email') email: string | undefined,
    @Args('id') id: string | undefined,
    @Context() ctx: GqlContext,
  ) {
    // Requires authentication — mirrors REST /api/users/lookup ownership gate
    if (!ctx.req.headers['x-user-id']) return null;
    if (email) return this.authService.lookupUserByEmail(email);
    if (id) return this.authService.lookupUserByID(id);
    return null;
  }

  @Mutation('revokeSession')
  @UseGuards(UserIdSigGuard)
  async revokeSession(
    @Args('id') sessionId: string,
    @Context() ctx: GqlContext,
  ): Promise<boolean> {
    const userId = requireUserId(ctx);
    return this.refreshTokenService.revokeSession(userId, sessionId);
  }
}
