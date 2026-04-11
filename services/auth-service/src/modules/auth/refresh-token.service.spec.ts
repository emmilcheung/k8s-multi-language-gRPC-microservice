import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';

function makeRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(),
  };
}

function makeConfig(ttl: number | string = 604800) {
  return {
    get: vi.fn().mockImplementation((key: string, fallback?: unknown) => {
      if (key === 'REFRESH_TOKEN_TTL_SECONDS') {
        return ttl;
      }
      return fallback;
    }),
  };
}

describe('RefreshTokenService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let service: RefreshTokenService;

  beforeEach(() => {
    redis = makeRedis();
    service = new RefreshTokenService(redis as never, makeConfig() as never);
  });

  it('should issue selector.secret tokens and persist only a hashed secret', async () => {
    redis.set.mockResolvedValue('OK');
    redis.sadd.mockResolvedValue(1);

    const token = await service.issue('user-uuid-1');

    const [sessionId, secret] = token.split('.');
    expect(sessionId).toBeTruthy();
    expect(secret).toBeTruthy();

    const [key, rawValue, exKeyword, ttl] = redis.set.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(key).toBe(`auth-service:refresh:session:${sessionId}`);
    expect(exKeyword).toBe('EX');
    expect(ttl).toBe(604800);
    expect(redis.sadd).toHaveBeenCalledWith(
      'auth-service:user-sessions:user-uuid-1',
      sessionId,
    );

    const stored = JSON.parse(rawValue) as {
      sessionId: string;
      userId: string;
      tokenHash: string;
      createdAt: string;
      lastRotatedAt: string;
    };
    expect(stored.sessionId).toBe(sessionId);
    expect(stored.userId).toBe('user-uuid-1');
    expect(stored.tokenHash).toHaveLength(64);
    expect(rawValue).not.toContain(secret);
  });

  it('should validate a token when the selector exists and the secret hash matches', async () => {
    redis.set.mockResolvedValue('OK');
    redis.sadd.mockResolvedValue(1);
    const token = await service.issue('user-uuid-1');
    const [sessionId] = token.split('.');
    const [, rawValue] = redis.set.mock.calls[0] as [string, string];
    redis.get.mockResolvedValue(rawValue);

    const userId = await service.validate(token);

    expect(redis.get).toHaveBeenCalledWith(
      `auth-service:refresh:session:${sessionId}`,
    );
    expect(userId).toBe('user-uuid-1');
  });

  it('should reject malformed refresh tokens', async () => {
    await expect(service.validate('not-a-valid-token')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('should reject refresh tokens with the wrong secret for a valid selector', async () => {
    redis.set.mockResolvedValue('OK');
    redis.sadd.mockResolvedValue(1);
    const token = await service.issue('user-uuid-1');
    const [sessionId] = token.split('.');
    const [, rawValue] = redis.set.mock.calls[0] as [string, string];
    redis.get.mockResolvedValue(rawValue);

    await expect(
      service.validate(`${sessionId}.tampered-secret`),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should revoke by selector and ignore malformed revoke input', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({
        sessionId: 'selector-123',
        userId: 'user-uuid-1',
        createdAt: new Date().toISOString(),
        lastRotatedAt: new Date().toISOString(),
        userAgent: null,
        ipAddress: null,
        tokenHash: 'a'.repeat(64),
      }),
    );
    redis.del.mockResolvedValue(1);
    redis.srem.mockResolvedValue(1);

    await service.revoke('selector-123.secret-456');
    await service.revoke('bad-token');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(
      'auth-service:refresh:session:selector-123',
    );
    expect(redis.srem).toHaveBeenCalledWith(
      'auth-service:user-sessions:user-uuid-1',
      'selector-123',
    );
  });

  it('should rotate a refresh token within the same session id', async () => {
    redis.set.mockResolvedValue('OK');
    redis.sadd.mockResolvedValue(1);
    const token = await service.issue('user-uuid-1', {
      userAgent: 'Browser/1.0',
      ipAddress: '203.0.113.10',
    });
    const [sessionId] = token.split('.');
    const [, rawValue] = redis.set.mock.calls[0] as [string, string];
    redis.get.mockResolvedValue(rawValue);

    const rotated = await service.rotate(token, {
      userAgent: 'Browser/2.0',
      ipAddress: '203.0.113.10',
    });

    expect(rotated.userId).toBe('user-uuid-1');
    expect(rotated.sessionId).toBe(sessionId);
    expect(rotated.refreshToken).not.toBe(token);
    expect(rotated.refreshToken.startsWith(`${sessionId}.`)).toBe(true);
  });

  it('should list active sessions for a user and remove stale index entries', async () => {
    redis.smembers.mockResolvedValue(['session-1', 'session-stale']);
    redis.get
      .mockResolvedValueOnce(
        JSON.stringify({
          sessionId: 'session-1',
          userId: 'user-uuid-1',
          createdAt: '2026-04-10T00:00:00.000Z',
          lastRotatedAt: '2026-04-11T00:00:00.000Z',
          userAgent: 'Browser/1.0',
          ipAddress: '203.0.113.10',
          tokenHash: 'a'.repeat(64),
        }),
      )
      .mockResolvedValueOnce(null);
    redis.srem.mockResolvedValue(1);

    const sessions = await service.listSessions('user-uuid-1');

    expect(sessions).toEqual([
      {
        sessionId: 'session-1',
        userId: 'user-uuid-1',
        createdAt: '2026-04-10T00:00:00.000Z',
        lastRotatedAt: '2026-04-11T00:00:00.000Z',
        userAgent: 'Browser/1.0',
        ipAddress: '203.0.113.10',
      },
    ]);
    expect(redis.srem).toHaveBeenCalledWith(
      'auth-service:user-sessions:user-uuid-1',
      'session-stale',
    );
  });

  it('should revoke a specific session owned by the user', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({
        sessionId: 'session-1',
        userId: 'user-uuid-1',
        createdAt: '2026-04-10T00:00:00.000Z',
        lastRotatedAt: '2026-04-11T00:00:00.000Z',
        userAgent: 'Browser/1.0',
        ipAddress: '203.0.113.10',
        tokenHash: 'a'.repeat(64),
      }),
    );
    redis.del.mockResolvedValue(1);
    redis.srem.mockResolvedValue(1);

    const revoked = await service.revokeSession('user-uuid-1', 'session-1');

    expect(revoked).toBe(true);
    expect(redis.del).toHaveBeenCalledWith(
      'auth-service:refresh:session:session-1',
    );
    expect(redis.srem).toHaveBeenCalledWith(
      'auth-service:user-sessions:user-uuid-1',
      'session-1',
    );
  });
});
