import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthResolver } from './auth.resolver';

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

      const result = await resolver.resolveReference({ __typename: 'User', id: 'user-456' });

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
