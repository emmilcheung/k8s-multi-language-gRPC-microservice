/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminController } from './admin.controller';
import { ChangeRoleDto } from './admin.dto';
import type { AdminService } from './admin.service';
import type { AuthService } from '../auth/auth.service';
import type { UsersRepository } from '../users/users.repository';

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const CALLER_ID = '22222222-2222-4222-8222-222222222222';

function setup(opts: {
  callerRolesInDb?: string[];
  tokenClaimsRoles?: string[];
  verifyFails?: boolean;
}) {
  const authService = {
    verifySessionAccessToken: opts.verifyFails
      ? vi.fn().mockRejectedValue(new UnauthorizedException())
      : vi.fn().mockResolvedValue({
          sub: CALLER_ID,
          jti: 'jti',
          roles: opts.tokenClaimsRoles ?? [],
        }),
  } as unknown as AuthService;
  const usersRepo = {
    findById: vi
      .fn()
      .mockResolvedValue(
        opts.callerRolesInDb
          ? { id: CALLER_ID, roles: opts.callerRolesInDb }
          : null,
      ),
  } as unknown as UsersRepository;
  const adminService = {
    changeRole: vi.fn().mockResolvedValue({ userId: TARGET_ID, roles: [] }),
  } as unknown as AdminService;
  const config = {
    get: vi.fn((key: string, fallback?: unknown) =>
      key === 'JWT_COOKIE_NAME' ? 'token' : fallback,
    ),
  } as unknown as ConfigService;
  const controller = new AdminController(
    authService,
    usersRepo,
    adminService,
    config,
  );
  return { controller, adminService, authService };
}

function req(opts: {
  bearer?: string;
  cookie?: string;
  headers?: Record<string, string>;
}): Request {
  return {
    headers: {
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.headers ?? {}),
    },
    cookies: opts.cookie ? { token: opts.cookie } : {},
  } as unknown as Request;
}

const dto = Object.assign(new ChangeRoleDto(), {
  role: 'platform_support',
  action: 'grant',
  reason: 'joins the support rota',
});

describe('only a platform admin can grant roles', () => {
  it('should refuse a caller whose stored roles lack platform_admin even if the token claims it', async () => {
    const { controller, adminService } = setup({
      callerRolesInDb: ['platform_support'],
      tokenClaimsRoles: ['platform_admin'],
    });
    await expect(
      controller.changeRole(TARGET_ID, dto, req({ bearer: 'tok' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(adminService.changeRole).not.toHaveBeenCalled();
  });

  it('should not trust an X-User-Roles header that says platform_admin', async () => {
    const { controller, adminService } = setup({ callerRolesInDb: [] });
    await expect(
      controller.changeRole(
        TARGET_ID,
        dto,
        req({
          bearer: 'tok',
          headers: { 'x-user-roles': 'platform_admin' },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(adminService.changeRole).not.toHaveBeenCalled();
  });

  it('should refuse a request with no token, however the headers look', async () => {
    const { controller } = setup({ callerRolesInDb: ['platform_admin'] });
    await expect(
      controller.changeRole(
        TARGET_ID,
        dto,
        req({
          headers: {
            'x-user-id': CALLER_ID,
            'x-user-roles': 'platform_admin',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('should refuse a token that fails verification (for example a delegated OAuth token)', async () => {
    const { controller } = setup({
      callerRolesInDb: ['platform_admin'],
      verifyFails: true,
    });
    await expect(
      controller.changeRole(TARGET_ID, dto, req({ bearer: 'oauth-tok' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('should refuse a caller who no longer exists', async () => {
    const { controller } = setup({});
    await expect(
      controller.changeRole(TARGET_ID, dto, req({ bearer: 'tok' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('should apply the change as the caller when the stored roles include platform_admin', async () => {
    const { controller, adminService } = setup({
      callerRolesInDb: ['platform_admin'],
    });
    await controller.changeRole(TARGET_ID, dto, req({ cookie: 'tok' }));
    expect(adminService.changeRole).toHaveBeenCalledWith({
      actorUserId: CALLER_ID,
      targetUserId: TARGET_ID,
      role: 'platform_support',
      action: 'grant',
      reason: 'joins the support rota',
    });
  });
});

describe('role change request body', () => {
  async function errorsFor(body: Record<string, unknown>) {
    const errors = await validate(plainToInstance(ChangeRoleDto, body));
    return errors.map((e) => e.property);
  }

  it('should reject role names other than the two platform roles', async () => {
    expect(
      await errorsFor({ role: 'organizer', action: 'grant', reason: 'x y z' }),
    ).toEqual(['role']);
    expect(
      await errorsFor({ role: 'superuser', action: 'grant', reason: 'x y z' }),
    ).toEqual(['role']);
  });

  it('should require a non-blank reason', async () => {
    expect(
      await errorsFor({ role: 'platform_admin', action: 'grant' }),
    ).toEqual(['reason']);
    expect(
      await errorsFor({
        role: 'platform_admin',
        action: 'grant',
        reason: '   ',
      }),
    ).toEqual(['reason']);
  });

  it('should only allow the grant and remove actions', async () => {
    expect(
      await errorsFor({ role: 'platform_admin', action: 'set', reason: 'why' }),
    ).toEqual(['action']);
  });

  it('should accept a valid removal', async () => {
    expect(
      await errorsFor({
        role: 'platform_support',
        action: 'remove',
        reason: 'left the team',
      }),
    ).toEqual([]);
  });
});
