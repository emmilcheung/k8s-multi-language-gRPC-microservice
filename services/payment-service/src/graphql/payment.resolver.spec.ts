import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PaymentResolver, PaymentMethodResolver } from './payment.resolver';
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

describe('PaymentMethodResolver', () => {
  const mockPaymentsService = {
    listSavedPaymentMethods: vi.fn(),
    registerSavedPaymentMethod: vi.fn(),
    setDefaultSavedPaymentMethod: vi.fn(),
    deleteSavedPaymentMethod: vi.fn(),
  };
  let resolver: PaymentMethodResolver;

  beforeEach(() => {
    resolver = new PaymentMethodResolver(mockPaymentsService as unknown as PaymentsService);
    vi.clearAllMocks();
  });

  const sampleMethod = {
    id: 'pm-1',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    isDefault: true,
  };

  describe('paymentMethods', () => {
    it('lists payment methods for the caller', async () => {
      mockPaymentsService.listSavedPaymentMethods.mockResolvedValue([sampleMethod]);
      const ctx = { req: { headers: { 'x-user-id': 'u-1' } } };
      const out = await resolver.paymentMethods(ctx);
      expect(mockPaymentsService.listSavedPaymentMethods).toHaveBeenCalledWith('u-1');
      expect(out).toEqual([
        {
          id: 'pm-1',
          brand: 'visa',
          last4: '4242',
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
          label: 'VISA •••• 4242',
        },
      ]);
    });

    it('throws ForbiddenException when X-User-Id missing', async () => {
      const ctx = { req: { headers: {} } };
      await expect(resolver.paymentMethods(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('registerPaymentMethod', () => {
    it('registers a payment method with consent context from headers', async () => {
      mockPaymentsService.registerSavedPaymentMethod.mockResolvedValue(sampleMethod);
      const ctx = {
        req: {
          headers: {
            'x-user-id': 'u-1',
            'x-consent-source': 'web',
            'user-agent': 'curl/8',
            'x-forwarded-for': '1.1.1.1, 2.2.2.2',
          },
        },
      };
      const input = {
        providerPaymentMethodId: 'pm_stripe',
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: 'v1',
      };
      const out = await resolver.registerPaymentMethod(input, ctx);
      expect(mockPaymentsService.registerSavedPaymentMethod).toHaveBeenCalledWith(
        'u-1',
        {
          providerPaymentMethodId: 'pm_stripe',
          setAsDefault: true,
          consentAccepted: true,
          consentVersion: 'v1',
        },
        {
          source: 'web',
          userAgent: 'curl/8',
          ipAddress: '1.1.1.1',
        },
      );
      expect(out.id).toBe('pm-1');
      expect(out.label).toBe('VISA •••• 4242');
    });
  });

  describe('setDefaultPaymentMethod', () => {
    it('delegates to service with caller id', async () => {
      mockPaymentsService.setDefaultSavedPaymentMethod.mockResolvedValue(sampleMethod);
      const ctx = { req: { headers: { 'x-user-id': 'u-1' } } };
      const out = await resolver.setDefaultPaymentMethod('pm-1', ctx);
      expect(mockPaymentsService.setDefaultSavedPaymentMethod).toHaveBeenCalledWith('u-1', 'pm-1');
      expect(out.id).toBe('pm-1');
    });
  });

  describe('deletePaymentMethod', () => {
    it('returns true after delete', async () => {
      mockPaymentsService.deleteSavedPaymentMethod.mockResolvedValue(undefined);
      const ctx = { req: { headers: { 'x-user-id': 'u-1' } } };
      const out = await resolver.deletePaymentMethod('pm-1', ctx);
      expect(mockPaymentsService.deleteSavedPaymentMethod).toHaveBeenCalledWith('u-1', 'pm-1');
      expect(out).toBe(true);
    });
  });
});
