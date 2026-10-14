import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { UsersRepository } from '../users/users.repository';
import { AdminService } from './admin.service';
import { ChangeRoleDto } from './admin.dto';
import { PLATFORM_ADMIN } from './platform-roles';

const DEFAULT_ACCESS_TOKEN_COOKIE = 'token';

@Controller('admin/users')
export class AdminController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersRepo: UsersRepository,
    private readonly adminService: AdminService,
    private readonly config: ConfigService,
  ) {}

  // POST /admin/users/:id/roles — grant or remove a platform role.
  @Post(':id/roles')
  @HttpCode(HttpStatus.OK)
  async changeRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeRoleDto,
    @Req() req: Request,
  ) {
    const actorUserId = await this.requirePlatformAdmin(req);
    const { userId, roles } = await this.adminService.changeRole({
      actorUserId,
      targetUserId: id,
      role: dto.role,
      action: dto.action,
      reason: dto.reason,
    });
    return { userId, roles };
  }

  /**
   * The caller is whoever holds a valid session token that auth-service
   * issued. Their roles are read from the database, never from the token's
   * roles claim or from X-User-Roles, so a revoked admin loses access at once
   * rather than when their token expires.
   */
  private async requirePlatformAdmin(req: Request): Promise<string> {
    const token = this.bearerToken(req) ?? this.cookieToken(req);
    if (!token) throw this.unauthenticated();

    let sub: string;
    try {
      ({ sub } = await this.authService.verifySessionAccessToken(token));
    } catch {
      throw this.unauthenticated();
    }

    const caller = await this.usersRepo.findById(sub);
    if (!caller) throw this.unauthenticated();
    if (!caller.roles.includes(PLATFORM_ADMIN)) {
      throw new ForbiddenException({
        error: {
          code: 'FORBIDDEN',
          message: 'Platform admin role required',
        },
      });
    }
    return caller.id;
  }

  private bearerToken(req: Request): string | undefined {
    const header = req.headers['authorization'];
    const match =
      typeof header === 'string' ? /^Bearer (\S+)$/i.exec(header) : null;
    return match?.[1];
  }

  private cookieToken(req: Request): string | undefined {
    const name = this.config.get<string>(
      'JWT_COOKIE_NAME',
      DEFAULT_ACCESS_TOKEN_COOKIE,
    );
    return (req.cookies as Record<string, string> | undefined)?.[name];
  }

  private unauthenticated(): UnauthorizedException {
    return new UnauthorizedException({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  }
}
