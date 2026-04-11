import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';

function makeRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
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

    const token = await service.issue('user-uuid-1');

    const [selector, secret] = token.split('.');
    expect(selector).toBeTruthy();
    expect(secret).toBeTruthy();

    const [key, rawValue, exKeyword, ttl] = redis.set.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(key).toBe(`auth-service:refresh:${selector}`);
    expect(exKeyword).toBe('EX');
    expect(ttl).toBe(604800);

    const stored = JSON.parse(rawValue) as {
      userId: string;
      tokenHash: string;
      issuedAt: string;
    };
    expect(stored.userId).toBe('user-uuid-1');
    expect(stored.tokenHash).toHaveLength(64);
    expect(rawValue).not.toContain(secret);
  });

  it('should validate a token when the selector exists and the secret hash matches', async () => {
    redis.set.mockResolvedValue('OK');
    const token = await service.issue('user-uuid-1');
    const [selector] = token.split('.');
    const [, rawValue] = redis.set.mock.calls[0] as [string, string];
    redis.get.mockResolvedValue(rawValue);

    const userId = await service.validate(token);

    expect(redis.get).toHaveBeenCalledWith(`auth-service:refresh:${selector}`);
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
    const token = await service.issue('user-uuid-1');
    const [selector] = token.split('.');
    const [, rawValue] = redis.set.mock.calls[0] as [string, string];
    redis.get.mockResolvedValue(rawValue);

    await expect(service.validate(`${selector}.tampered-secret`)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should revoke by selector and ignore malformed revoke input', async () => {
    redis.del.mockResolvedValue(1);

    await service.revoke('selector-123.secret-456');
    await service.revoke('bad-token');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('auth-service:refresh:selector-123');
  });
});