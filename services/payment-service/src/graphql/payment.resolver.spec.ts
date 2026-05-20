import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentResolver } from './payment.resolver';
import type { PaymentsService } from '../modules/payments/payments.service';

type PaymentContext = Parameters<PaymentResolver['resolveReference']>[1];

describe('PaymentResolver', () => {
  let resolver: PaymentResolver;
  const mockPaymentsService = {
    findById: vi.fn(),
    findByOrderId: vi.fn(),
  } satisfies Pick<PaymentsService, 'findById' | 'findByOrderId'>;

  beforeEach(() => {
    resolver = new PaymentResolver(mockPaymentsService as unknown as PaymentsService);
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

    it('resolves Payment reference by orderId', async () => {
      mockPaymentsService.findByOrderId.mockResolvedValue({
        id: 'pay_123',
        orderId: 'ord_123',
        userId: 'user_123',
        amount: 1200,
        currency: 'usd',
        status: 'CAPTURED',
        createdAt: new Date().toISOString(),
      });

      const result = await resolver.resolveReference(
        { __typename: 'Payment', orderId: 'ord_123' } as Parameters<
          PaymentResolver['resolveReference']
        >[0],
        { req: { headers: { 'x-user-id': 'user_123' } } },
      );

      expect(mockPaymentsService.findByOrderId).toHaveBeenCalledWith('ord_123');
      expect(result?.id).toBe('pay_123');
    });

    it('returns null for orderId reference owned by a different user', async () => {
      mockPaymentsService.findByOrderId.mockResolvedValue({
        id: 'pay_123',
        orderId: 'ord_123',
        userId: 'user_123',
        amount: 1200,
        currency: 'usd',
        status: 'CAPTURED',
        createdAt: new Date().toISOString(),
      });

      const result = await resolver.resolveReference(
        { __typename: 'Payment', orderId: 'ord_123' } as Parameters<
          PaymentResolver['resolveReference']
        >[0],
        { req: { headers: { 'x-user-id': 'other-user' } } },
      );

      expect(mockPaymentsService.findByOrderId).toHaveBeenCalledWith('ord_123');
      expect(result).toBeNull();
    });

    it('returns null when orderId reference is not found', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      mockPaymentsService.findByOrderId.mockRejectedValue(new NotFoundException());

      const result = await resolver.resolveReference(
        { __typename: 'Payment', orderId: 'ord_123' } as Parameters<
          PaymentResolver['resolveReference']
        >[0],
        { req: { headers: { 'x-user-id': 'user_123' } } },
      );

      expect(mockPaymentsService.findByOrderId).toHaveBeenCalledWith('ord_123');
      expect(result).toBeNull();
    });

    it('returns null when entity not found', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      mockPaymentsService.findById.mockRejectedValue(new NotFoundException());

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'missing' }, ctx);
      expect(result).toBeNull();
    });

    it('returns null when requester identity is missing', async () => {
      const payment = { id: 'pay-1', userId: 'user-123', amount: 5000 };
      mockPaymentsService.findById.mockResolvedValue(payment);

      const ctx: PaymentContext = { req: { headers: {} } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'pay-1' }, ctx);

      expect(result).toBeNull();
    });

    it('resolveReference — returns null for payment owned by different user', async () => {
      const payment = { id: 'pay-1', userId: 'user-1', amount: 100 };
      mockPaymentsService.findById.mockResolvedValue(payment as any);

      const ctx: PaymentContext = { req: { headers: { 'x-user-id': 'user-2' } } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'pay-1' }, ctx);
      expect(result).toBeNull();
    });
  });
});
