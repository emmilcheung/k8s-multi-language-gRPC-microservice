import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentResolver } from './payment.resolver';

describe('PaymentResolver', () => {
  let resolver: PaymentResolver;
  const mockPaymentsService = {
    findById: vi.fn(),
  };

  beforeEach(() => {
    resolver = new PaymentResolver(mockPaymentsService as any);
    vi.clearAllMocks();
  });

  describe('payment query', () => {
    it('returns payment when requester owns the payment', async () => {
      const payment = {
        id: 'pay-1',
        userId: 'user-123',
        orderId: 'ord-1',
        amount: 5000,
        currency: 'usd',
        status: 'CAPTURED',
        createdAt: new Date(),
      };
      mockPaymentsService.findById.mockResolvedValue(payment);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.payment('pay-1', ctx);

      expect(result).toEqual(payment);
    });

    it('returns null when requester does not own the payment', async () => {
      const payment = {
        id: 'pay-1',
        userId: 'user-123',
        orderId: 'ord-1',
        amount: 5000,
        currency: 'usd',
        status: 'CAPTURED',
        createdAt: new Date(),
      };
      mockPaymentsService.findById.mockResolvedValue(payment);

      const ctx = { req: { headers: { 'x-user-id': 'other-user' } } };
      const result = await resolver.payment('pay-1', ctx);

      expect(result).toBeNull();
    });

    it('returns null when payment is not found', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      mockPaymentsService.findById.mockRejectedValue(new NotFoundException());

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.payment('pay-1', ctx);

      expect(result).toBeNull();
    });
  });

  describe('resolveReference', () => {
    it('resolves a Payment entity by id', async () => {
      const payment = { id: 'pay-1', userId: 'user-123', amount: 5000 };
      mockPaymentsService.findById.mockResolvedValue(payment);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'pay-1' }, ctx);
      expect(result).toEqual(payment);
    });

    it('returns null when entity not found', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      mockPaymentsService.findById.mockRejectedValue(new NotFoundException());

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'missing' }, ctx);
      expect(result).toBeNull();
    });

    it('resolveReference — returns null for payment owned by different user', async () => {
      const payment = { id: 'pay-1', userId: 'user-1', amount: 100 };
      mockPaymentsService.findById.mockResolvedValue(payment as any);

      const ctx = { req: { headers: { 'x-user-id': 'user-2' } } };
      const result = await resolver.resolveReference(
        { __typename: 'Payment', id: 'pay-1' },
        ctx as any,
      );
      expect(result).toBeNull();
    });
  });
});
