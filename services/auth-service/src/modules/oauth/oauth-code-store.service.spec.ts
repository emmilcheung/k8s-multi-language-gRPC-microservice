import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OAuthCodeStoreService } from './oauth-code-store.service';

function makeRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
}

const BASE_RECORD = {
  clientId: 'ticketing-mcp',
  userId: 'user-uuid-1',
  scope: 'tickets:read orders:read',
  codeChallenge: 'challenge-abc',
  codeChallengeMethod: 'S256',
  redirectUri: 'http://127.0.0.1:19836/callback',
};

describe('OAuthCodeStoreService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let service: OAuthCodeStoreService;

  beforeEach(() => {
    redis = makeRedis();
    service = new OAuthCodeStoreService(redis as never);
  });

  // ── storeCode ──────────────────────────────────────────────────────────────

  describe('storeCode', () => {
    it('returns an opaque base64url code string', async () => {
      redis.set.mockResolvedValue('OK');
      const code = await service.storeCode(BASE_RECORD);
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
      // base64url characters only
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('stores under the correct key with a 600s TTL', async () => {
      redis.set.mockResolvedValue('OK');
      const code = await service.storeCode(BASE_RECORD);

      expect(redis.set).toHaveBeenCalledWith(
        `auth-service:oauth:code:${code}`,
        expect.stringContaining('"clientId":"ticketing-mcp"'),
        'EX',
        600,
      );
    });

    it('generates a unique code each call', async () => {
      redis.set.mockResolvedValue('OK');
      const [a, b] = await Promise.all([
        service.storeCode(BASE_RECORD),
        service.storeCode(BASE_RECORD),
      ]);
      expect(a).not.toBe(b);
    });
  });

  // ── consumeCode ────────────────────────────────────────────────────────────

  describe('consumeCode', () => {
    it('returns the record and deletes the key', async () => {
      const stored = {
        ...BASE_RECORD,
        code: 'tok1',
        createdAt: new Date().toISOString(),
      };
      redis.get.mockResolvedValue(JSON.stringify(stored));
      redis.del.mockResolvedValue(1);

      const result = await service.consumeCode('tok1');

      expect(result).toMatchObject({
        clientId: 'ticketing-mcp',
        userId: 'user-uuid-1',
      });
      expect(redis.del).toHaveBeenCalledWith('auth-service:oauth:code:tok1');
    });

    it('returns null and still deletes when code is missing', async () => {
      redis.get.mockResolvedValue(null);
      const result = await service.consumeCode('nonexistent');
      expect(result).toBeNull();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('returns null and deletes the key when stored JSON is malformed', async () => {
      redis.get.mockResolvedValue('{bad json}');
      redis.del.mockResolvedValue(1);
      const result = await service.consumeCode('corrupt');
      expect(result).toBeNull();
      expect(redis.del).toHaveBeenCalled();
    });

    it('returns null when stored object is missing required fields', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ clientId: 'ticketing-mcp' }),
      );
      redis.del.mockResolvedValue(1);
      const result = await service.consumeCode('incomplete');
      expect(result).toBeNull();
    });
  });

  // ── session scope ──────────────────────────────────────────────────────────

  describe('storeSessionScope / getSessionScope / deleteSessionScope', () => {
    it('round-trips scope metadata', async () => {
      const meta = { scope: 'tickets:read', clientId: 'ticketing-mcp' };
      redis.set.mockResolvedValue('OK');
      redis.get.mockResolvedValue(JSON.stringify(meta));

      await service.storeSessionScope('session-1', meta, 86400);
      const result = await service.getSessionScope('session-1');

      expect(result).toEqual(meta);
      expect(redis.set).toHaveBeenCalledWith(
        'auth-service:oauth:session-scope:session-1',
        JSON.stringify(meta),
        'EX',
        86400,
      );
    });

    it('returns null when session not found', async () => {
      redis.get.mockResolvedValue(null);
      expect(await service.getSessionScope('missing')).toBeNull();
    });

    it('returns null when stored value has wrong shape', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ wrong: 'shape' }));
      expect(await service.getSessionScope('bad')).toBeNull();
    });

    it('deleteSessionScope calls del on the correct key', async () => {
      redis.del.mockResolvedValue(1);
      await service.deleteSessionScope('session-1');
      expect(redis.del).toHaveBeenCalledWith(
        'auth-service:oauth:session-scope:session-1',
      );
    });
  });
});
