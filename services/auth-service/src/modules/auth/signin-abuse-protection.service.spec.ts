import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import { SigninAbuseProtectionService } from './signin-abuse-protection.service';

function makeRedis() {
  return {
    exists: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
}

function makeConfig(overrides: Record<string, number | string> = {}) {
  return {
    get: vi.fn().mockImplementation((key: string, fallback?: unknown) => {
      if (key in overrides) {
        return overrides[key];
      }
      return fallback;
    }),
  };
}

function makeLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('SigninAbuseProtectionService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let service: SigninAbuseProtectionService;

  beforeEach(() => {
    redis = makeRedis();
    service = new SigninAbuseProtectionService(
      makeLogger() as never,
      redis as never,
      makeConfig() as never,
    );
  });

  it('should allow sign-in when no lock is active', async () => {
    redis.exists.mockResolvedValue(0);

    await expect(
      service.assertNotThrottled('user@example.com', '203.0.113.10'),
    ).resolves.toBeUndefined();
  });

  it('should block sign-in when an IP or identity lock is active', async () => {
    redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(
      service.assertNotThrottled('user@example.com', '203.0.113.10'),
    ).rejects.toThrow(HttpException);
  });

  it('should create a lock after repeated failures', async () => {
    redis.incr.mockResolvedValue(5);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);

    await service.recordFailure('user@example.com', '203.0.113.10');

    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenCalledTimes(2);
  });

  it('should set the failure window on the first failed attempt', async () => {
    redis.incr.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);

    await service.recordFailure('user@example.com', null);

    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('should clear counters and locks after a successful sign-in', async () => {
    redis.del.mockResolvedValue(4);

    await service.recordSuccess('user@example.com', '203.0.113.10');

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect((redis.del.mock.calls[0] as unknown[]).length).toBe(4);
  });
});
