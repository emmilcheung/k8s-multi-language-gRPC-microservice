import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AuthResolver, SessionResolver } from './auth.resolver';

describe('AuthResolver', () => {
  let resolver: AuthResolver;
  const mockUsersRepository = {
    findById: vi.fn(),
  };

  beforeEach(() => {
    resolver = new AuthResolver(mockUsersRepository as any);
    vi.clearAllMocks();
  });

  describe('currentUser', () => {
    it('returns the user when X-User-Id header is present', async () => {
      const user = { id: 'user-123', email: 'test@test.com' };
      mockUsersRepository.findById.mockResolvedValue(user);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.currentUser(ctx);

      expect(result).toEqual({ id: 'user-123', email: 'test@test.com' });
      expect(mockUsersRepository.findById).toHaveBeenCalledWith('user-123');
    });

    it('returns null when X-User-Id header is missing', async () => {
      const ctx = { req: { headers: {} } };
      const result = await resolver.currentUser(ctx);

      expect(result).toBeNull();
      expect(mockUsersRepository.findById).not.toHaveBeenCalled();
    });
  });

  describe('resolveReference', () => {
    it('resolves a User entity by id', async () => {
      const user = { id: 'user-456', email: 'other@test.com' };
      mockUsersRepository.findById.mockResolvedValue(user);

      const result = await resolver.resolveReference({
        __typename: 'User',
        id: 'user-456',
      });

      expect(result).toEqual({ id: 'user-456', email: 'other@test.com' });
    });
  });

  describe('email field', () => {
    it('returns email when requester is the user', () => {
      const user = { id: 'user-123', email: 'self@test.com' };
      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };

      const result = resolver.email(user, ctx);
      expect(result).toBe('self@test.com');
    });

    it('returns null when requester is a different user', () => {
      const user = { id: 'user-123', email: 'self@test.com' };
      const ctx = { req: { headers: { 'x-user-id': 'other-user' } } };

      const result = resolver.email(user, ctx);
      expect(result).toBeNull();
    });
  });
});

describe('SessionResolver', () => {
  const mockRefreshTokenService = {
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    extractSessionId: vi.fn(),
  };
  const mockAuthService = {
    lookupUserByEmail: vi.fn(),
    lookupUserByID: vi.fn(),
  };
  const mockConfig = {
    get: vi.fn((_k: string, fallback: string) => fallback),
  };
  let resolver: SessionResolver;

  beforeEach(() => {
    resolver = new SessionResolver(
      mockRefreshTokenService as any,
      mockAuthService as any,
      mockConfig as any,
    );
    vi.clearAllMocks();
  });

  describe('sessions', () => {
    it('maps RefreshSession rows and marks the current cookie session', async () => {
      mockRefreshTokenService.extractSessionId.mockReturnValue('sess-1');
      mockRefreshTokenService.listSessions.mockResolvedValue([
        {
          sessionId: 'sess-1',
          userAgent: 'curl',
          ipAddress: '1.1.1.1',
          createdAt: '2026-05-01T00:00:00Z',
          lastRotatedAt: '2026-05-02T00:00:00Z',
        },
        {
          sessionId: 'sess-2',
          userAgent: null,
          ipAddress: null,
          createdAt: '2026-05-01T00:00:00Z',
          lastRotatedAt: '2026-05-01T00:00:00Z',
        },
      ]);
      const ctx = {
        req: {
          headers: { 'x-user-id': 'u-1' },
          cookies: { refresh_token: 'cookie' },
        },
      };
      const out = await resolver.sessions(ctx as any);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({
        id: 'sess-1',
        current: true,
        lastUsedAt: '2026-05-02T00:00:00Z',
      });
      expect(out[1]).toMatchObject({ id: 'sess-2', current: false });
    });

    it('throws when X-User-Id missing', async () => {
      const ctx = { req: { headers: {}, cookies: {} } };
      await expect(resolver.sessions(ctx as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('userLookup', () => {
    it('returns user by email when caller is organizer', async () => {
      mockAuthService.lookupUserByEmail.mockResolvedValue({
        id: 'u',
        email: 'x@y',
      });
      const ctx = {
        req: {
          headers: { 'x-user-id': 'u-1', 'x-user-roles': 'organizer' },
        },
      };
      const out = await resolver.userLookup('x@y', undefined, ctx as any);
      expect(out).toEqual({ id: 'u', email: 'x@y' });
    });

    it('returns null for non-organizer caller', async () => {
      const ctx = {
        req: { headers: { 'x-user-id': 'u-1', 'x-user-roles': 'buyer' } },
      };
      const out = await resolver.userLookup('x@y', undefined, ctx as any);
      expect(out).toBeNull();
      expect(mockAuthService.lookupUserByEmail).not.toHaveBeenCalled();
    });
  });

  describe('revokeSession', () => {
    it('delegates to refreshTokenService.revokeSession', async () => {
      mockRefreshTokenService.revokeSession.mockResolvedValue(true);
      const ctx = { req: { headers: { 'x-user-id': 'u-1' } } };
      const out = await resolver.revokeSession('sess-1', ctx as any);
      expect(mockRefreshTokenService.revokeSession).toHaveBeenCalledWith(
        'u-1',
        'sess-1',
      );
      expect(out).toBe(true);
    });
  });
});
