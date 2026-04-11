/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { RefreshTokenService } from './refresh-token.service';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAuthService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    signup: vi.fn().mockResolvedValue({
      accessToken: 'access.token',
      refreshToken: 'refresh-token-id',
    }),
    signin: vi.fn().mockResolvedValue({
      accessToken: 'access.token',
      refreshToken: 'refresh-token-id',
    }),
    blacklistAccessToken: vi.fn().mockResolvedValue(undefined),
    verifyAccessToken: vi.fn().mockResolvedValue({
      sub: 'user-uuid-1',
      email: 'user@example.com',
      jti: 'jti-1',
    }),
    issueAccessTokenForUser: vi.fn().mockResolvedValue('new.access.token'),
    getJwks: vi.fn().mockReturnValue({ keys: [{ kid: 'key-1' }] }),
    ...overrides,
  } as unknown as AuthService;
}

function makeRefreshTokenService(
  overrides: Partial<RefreshTokenService> = {},
): RefreshTokenService {
  return {
    issue: vi.fn().mockResolvedValue('new-refresh-token-id'),
    rotate: vi.fn().mockResolvedValue({
      userId: 'user-uuid-1',
      refreshToken: 'rotated-refresh-token-id',
      sessionId: 'session-uuid-1',
    }),
    validate: vi.fn().mockResolvedValue('user-uuid-1'),
    revoke: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    revokeSession: vi.fn().mockResolvedValue(true),
    extractSessionId: vi.fn().mockReturnValue('session-uuid-1'),
    ...overrides,
  } as unknown as RefreshTokenService;
}

function makeConfigService(
  env = 'test',
  expiry = '15m',
  overrides: Record<string, unknown> = {},
): ConfigService {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key in overrides) return overrides[key];
      if (key === 'NODE_ENV') return env;
      if (key === 'JWT_EXPIRY') return expiry;
      if (key === 'JWT_COOKIE_NAME') return 'token';
      if (key === 'REFRESH_COOKIE_NAME') return 'refreshToken';
      if (key === 'REFRESH_TOKEN_TTL_SECONDS') return 604800;
      if (key === 'REFRESH_COOKIE_PATH') return '/';
      if (key === 'ACCESS_TOKEN_COOKIE_SAME_SITE') return 'strict';
      if (key === 'REFRESH_TOKEN_COOKIE_SAME_SITE') return 'strict';
      if (key === 'COOKIE_DOMAIN') return undefined;
      return undefined;
    }),
    getOrThrow: vi.fn(),
  } as unknown as ConfigService;
}

function makeLogger(): PinoLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as PinoLogger;
}

/** Create a minimal Express-like response mock. */
function makeRes() {
  const res = {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return res as unknown as Response;
}

/** Create a minimal Express-like request mock with cookies and headers. */
function makeReq(
  options: {
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
): Request {
  return {
    cookies: options.cookies ?? {},
    headers: options.headers ?? {},
    ip: options.ip,
  } as unknown as Request;
}

function makeController(
  overrides: {
    authService?: Partial<AuthService>;
    refreshTokenService?: Partial<RefreshTokenService>;
    configService?: ConfigService;
  } = {},
) {
  const logger = makeLogger();
  const authService = makeAuthService(overrides.authService);
  const refreshTokenService = makeRefreshTokenService(
    overrides.refreshTokenService,
  );
  const configService = overrides.configService ?? makeConfigService();
  const controller = new AuthController(
    logger,
    authService,
    refreshTokenService,
    configService,
  );
  return {
    controller,
    authService,
    refreshTokenService,
    configService,
    logger,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthController', () => {
  describe('signup', () => {
    it('should call authService.signup with dto fields and set both cookies', async () => {
      const { controller, authService } = makeController();
      const res = makeRes();
      const req = makeReq({
        headers: {
          'user-agent': 'VitestBrowser/1.0',
          'x-forwarded-for': '203.0.113.10',
        },
      });

      const result = await controller.signup(
        { email: 'user@example.com', password: 'pass123' },
        req,
        res,
      );

      expect(authService.signup).toHaveBeenCalledWith(
        'user@example.com',
        'pass123',
        {
          userAgent: 'VitestBrowser/1.0',
          ipAddress: '203.0.113.10',
        },
      );
      expect(res.cookie).toHaveBeenCalledTimes(2);
      // access token cookie
      expect((res.cookie as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
        'token',
      );
      expect((res.cookie as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(
        'access.token',
      );
      // refresh token cookie
      expect((res.cookie as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe(
        'refreshToken',
      );
      expect((res.cookie as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe(
        'refresh-token-id',
      );
      expect(result).toEqual({ currentUser: { email: 'user@example.com' } });
    });

    it('should set HttpOnly cookies', async () => {
      const { controller } = makeController();
      const res = makeRes();
      const req = makeReq();

      await controller.signup({ email: 'a@b.com', password: 'p' }, req, res);

      const cookieCalls = (res.cookie as ReturnType<typeof vi.fn>).mock
        .calls as unknown[][];
      for (const [, , opts] of cookieCalls) {
        expect((opts as { httpOnly: boolean }).httpOnly).toBe(true);
      }
    });
  });

  describe('signin', () => {
    it('should call authService.signin and set both cookies', async () => {
      const { controller, authService } = makeController();
      const res = makeRes();
      const req = makeReq({ headers: { 'user-agent': 'VitestBrowser/1.0' } });

      const result = await controller.signin(
        { email: 'user@example.com', password: 'secret' },
        req,
        res,
      );

      expect(authService.signin).toHaveBeenCalledWith(
        'user@example.com',
        'secret',
        { userAgent: 'VitestBrowser/1.0', ipAddress: null },
      );
      expect(res.cookie).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ currentUser: { email: 'user@example.com' } });
    });
  });

  describe('signout', () => {
    it('should revoke refresh token and blacklist access token, then clear both cookies', async () => {
      const { controller, authService, refreshTokenService, logger } =
        makeController();
      const req = makeReq({
        cookies: { token: 'old.access.token', refreshToken: 'old-refresh-id' },
      });
      const res = makeRes();

      await controller.signout(req, res);

      expect(refreshTokenService.revoke).toHaveBeenCalledWith('old-refresh-id');
      expect(authService.blacklistAccessToken).toHaveBeenCalledWith(
        'old.access.token',
      );
      expect(res.clearCookie).toHaveBeenCalledWith('token', { path: '/' });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', {
        path: '/',
      });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', {
        path: '/api/auth/refresh',
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth.signout.completed' }),
        'Auth audit event',
      );
    });

    it('should succeed gracefully when there is no refresh token cookie', async () => {
      const { controller, refreshTokenService } = makeController();
      const req = makeReq({ cookies: {} });
      const res = makeRes();

      await controller.signout(req, res);

      expect(refreshTokenService.revoke).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledTimes(3);
    });

    it('should not throw if revoke fails (best-effort revocation)', async () => {
      const { controller } = makeController({
        refreshTokenService: {
          revoke: vi.fn().mockRejectedValue(new Error('redis down')),
        },
      });
      const req = makeReq({ cookies: { refreshToken: 'some-token' } });
      const res = makeRes();

      await expect(controller.signout(req, res)).resolves.not.toThrow();
    });
  });

  describe('refresh', () => {
    it('should validate old token, revoke it, issue a new pair, and set both cookies', async () => {
      const { controller, authService, refreshTokenService, logger } =
        makeController();
      const req = makeReq({
        cookies: { refreshToken: 'old-refresh-id' },
        headers: { 'user-agent': 'VitestBrowser/2.0' },
      });
      const res = makeRes();

      await controller.refresh(req, res);

      expect(refreshTokenService.rotate).toHaveBeenCalledWith(
        'old-refresh-id',
        { userAgent: 'VitestBrowser/2.0', ipAddress: null },
      );
      expect(authService.issueAccessTokenForUser).toHaveBeenCalledWith(
        'user-uuid-1',
      );
      expect(res.cookie).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.refresh.succeeded',
          userId: 'user-uuid-1',
          sessionId: 'session-uuid-1',
        }),
        'Auth audit event',
      );
    });

    it('should throw UnauthorizedException when refresh token cookie is missing', async () => {
      const { controller } = makeController();
      const req = makeReq({ cookies: {} });
      const res = makeRes();

      await expect(controller.refresh(req, res)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should propagate UnauthorizedException from RefreshTokenService.rotate', async () => {
      const { controller } = makeController({
        refreshTokenService: {
          rotate: vi
            .fn()
            .mockRejectedValue(new UnauthorizedException('invalid')),
        },
      });
      const req = makeReq({ cookies: { refreshToken: 'expired-token' } });
      const res = makeRes();

      await expect(controller.refresh(req, res)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('listSessions', () => {
    it('should return sessions for the authenticated user and mark the current session', async () => {
      const { controller, refreshTokenService } = makeController({
        refreshTokenService: {
          listSessions: vi.fn().mockResolvedValue([
            {
              sessionId: 'session-uuid-1',
              userId: 'user-uuid-1',
              createdAt: '2026-04-10T00:00:00.000Z',
              lastRotatedAt: '2026-04-11T00:00:00.000Z',
              userAgent: 'Browser/1.0',
              ipAddress: '203.0.113.10',
            },
            {
              sessionId: 'session-uuid-2',
              userId: 'user-uuid-1',
              createdAt: '2026-04-09T00:00:00.000Z',
              lastRotatedAt: '2026-04-10T00:00:00.000Z',
              userAgent: 'Browser/0.9',
              ipAddress: '203.0.113.11',
            },
          ]),
          extractSessionId: vi.fn().mockReturnValue('session-uuid-1'),
        },
      });
      const req = makeReq({
        cookies: { token: 'valid.jwt', refreshToken: 'session-uuid-1.secret' },
      });

      const result = await controller.listSessions(req);

      expect(refreshTokenService.listSessions).toHaveBeenCalledWith(
        'user-uuid-1',
      );
      expect(result).toEqual({
        sessions: [
          {
            sessionId: 'session-uuid-1',
            createdAt: '2026-04-10T00:00:00.000Z',
            lastRotatedAt: '2026-04-11T00:00:00.000Z',
            userAgent: 'Browser/1.0',
            ipAddress: '203.0.113.10',
            current: true,
          },
          {
            sessionId: 'session-uuid-2',
            createdAt: '2026-04-09T00:00:00.000Z',
            lastRotatedAt: '2026-04-10T00:00:00.000Z',
            userAgent: 'Browser/0.9',
            ipAddress: '203.0.113.11',
            current: false,
          },
        ],
      });
    });

    it('should require authentication to list sessions', async () => {
      const { controller } = makeController();

      await expect(controller.listSessions(makeReq())).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('revokeSession', () => {
    it('should revoke a session owned by the current user and clear cookies when revoking the current session', async () => {
      const { controller, refreshTokenService, logger } = makeController({
        refreshTokenService: {
          revokeSession: vi.fn().mockResolvedValue(true),
          extractSessionId: vi
            .fn()
            .mockReturnValue('ec1fd099-cf07-4f1b-930c-173e3a2f4be8'),
        },
      });
      const req = makeReq({
        cookies: {
          token: 'valid.jwt',
          refreshToken: 'ec1fd099-cf07-4f1b-930c-173e3a2f4be8.secret',
        },
      });
      const res = makeRes();

      await controller.revokeSession(
        'ec1fd099-cf07-4f1b-930c-173e3a2f4be8',
        req,
        res,
      );

      expect(refreshTokenService.revokeSession).toHaveBeenCalledWith(
        'user-uuid-1',
        'ec1fd099-cf07-4f1b-930c-173e3a2f4be8',
      );
      expect(res.clearCookie).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.session.revoked',
          userId: 'user-uuid-1',
          sessionId: 'ec1fd099-cf07-4f1b-930c-173e3a2f4be8',
          currentSessionRevoked: true,
        }),
        'Auth audit event',
      );
    });

    it('should throw NotFoundException when the session does not exist', async () => {
      const { controller, logger } = makeController({
        refreshTokenService: {
          revokeSession: vi.fn().mockResolvedValue(false),
        },
      });
      const req = makeReq({ cookies: { token: 'valid.jwt' } });
      const res = makeRes();

      await expect(
        controller.revokeSession(
          'ec1fd099-cf07-4f1b-930c-173e3a2f4be8',
          req,
          res,
        ),
      ).rejects.toThrow(NotFoundException);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth.session.revoke.missed' }),
        'Auth audit event',
      );
    });
  });

  describe('currentUser', () => {
    it('should return currentUser from verified JWT when token cookie is present', async () => {
      const { controller } = makeController();
      const req = makeReq({ cookies: { token: 'valid.jwt.token' } });

      const result = await controller.currentUser(req);

      expect(result).toEqual({
        currentUser: { id: 'user-uuid-1', email: 'user@example.com' },
      });
    });

    it('should return null when no token and no X-User-Id', async () => {
      const { controller } = makeController();
      const req = makeReq({ cookies: {}, headers: {} });

      const result = await controller.currentUser(req);

      expect(result).toEqual({ currentUser: null });
    });

    it('should return null when token verification fails (revoked/expired)', async () => {
      const { controller } = makeController({
        authService: {
          verifyAccessToken: vi
            .fn()
            .mockRejectedValue(new Error('token expired')),
        },
      });
      const req = makeReq({ cookies: { token: 'expired.jwt' } });

      const result = await controller.currentUser(req);

      expect(result).toEqual({ currentUser: null });
    });

    it('should return minimal identity from X-User-Id when no cookie is present', async () => {
      const { controller } = makeController();
      const req = makeReq({
        cookies: {},
        headers: { 'x-user-id': 'kong-injected-uuid' },
      });

      const result = await controller.currentUser(req);

      expect(result).toEqual({ currentUser: { id: 'kong-injected-uuid' } });
    });

    it('should return null when JWT sub and X-User-Id header disagree', async () => {
      const { controller } = makeController({
        authService: {
          verifyAccessToken: vi.fn().mockResolvedValue({
            sub: 'jwt-user-id',
            email: 'user@example.com',
            jti: 'jti-1',
          }),
        },
      });
      const req = makeReq({
        cookies: { token: 'valid.jwt' },
        headers: { 'x-user-id': 'different-user-id' },
      });

      const result = await controller.currentUser(req);

      expect(result).toEqual({ currentUser: null });
    });
  });

  describe('jwks', () => {
    it('should return the JWKS object from authService', () => {
      const { controller, authService } = makeController();

      const result = controller.jwks();

      expect(authService.getJwks).toHaveBeenCalledOnce();
      expect(result).toEqual({ keys: [{ kid: 'key-1' }] });
    });
  });

  describe('cookie settings', () => {
    it('should derive access token maxAge from JWT_EXPIRY config', async () => {
      const { controller } = makeController({
        configService: makeConfigService('test', '30m'),
      });
      const res = makeRes();
      const req = makeReq();

      await controller.signup({ email: 'a@b.com', password: 'p' }, req, res);

      const [, , opts] = (res.cookie as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, string, { maxAge: number }];
      // 30 minutes in milliseconds
      expect(opts.maxAge).toBe(30 * 60 * 1000);
    });

    it('should default refresh token cookie path to /', async () => {
      const { controller } = makeController();
      const res = makeRes();
      const req = makeReq();

      await controller.signup({ email: 'a@b.com', password: 'p' }, req, res);

      const [, , opts] = (res.cookie as ReturnType<typeof vi.fn>).mock
        .calls[1] as [string, string, { path: string }];
      expect(opts.path).toBe('/');
    });

    it('should honour REFRESH_COOKIE_PATH from config', async () => {
      const { controller } = makeController({
        configService: makeConfigService('test', '15m', {
          REFRESH_COOKIE_PATH: '/api/auth/refresh',
        }),
      });
      const res = makeRes();
      const req = makeReq();

      await controller.signup({ email: 'a@b.com', password: 'p' }, req, res);

      const [, , opts] = (res.cookie as ReturnType<typeof vi.fn>).mock
        .calls[1] as [string, string, { path: string }];
      expect(opts.path).toBe('/api/auth/refresh');
    });
  });
});
