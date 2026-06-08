import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PaymentResolver,
  UserPaymentMethodResolver,
  PaymentMethodMutationResolver,
} from './payment.resolver';
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
        status: 'completed',
        createdAt: new Date(),
      };
      mockPaymentsService.findById.mockResolvedValue(payment);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.payment('pay-1', ctx);

      expect(result).toEqual({ ...payment, status: 'CAPTURED' });
    });

    it('returns null when requester does not own the payment', async () => {
      const payment = {
        id: 'pay-1',
        userId: 'user-123',
        orderId: 'ord-1',
        amount: 5000,
        currency: 'usd',
        status: 'completed',
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
      const payment = { id: 'pay-1', userId: 'user-123', amount: 5000, status: 'completed' };
      mockPaymentsService.findById.mockResolvedValue(payment);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'pay-1' }, ctx);
      expect(result).toEqual({ ...payment, status: 'CAPTURED' });
    });

    it('resolves Payment reference by orderId', async () => {
      mockPaymentsService.findByOrderId.mockResolvedValue({
        id: 'pay_123',
        orderId: 'ord_123',
        userId: 'user_123',
        amount: 1200,
        currency: 'usd',
        status: 'completed',
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
        status: 'completed',
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
      const payment = { id: 'pay-1', userId: 'user-123', amount: 5000, status: 'completed' };
      mockPaymentsService.findById.mockResolvedValue(payment);

      const ctx: PaymentContext = { req: { headers: {} } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'pay-1' }, ctx);

      expect(result).toBeNull();
    });

    it('resolveReference — returns null for payment owned by different user', async () => {
      const payment = { id: 'pay-1', userId: 'user-1', amount: 100, status: 'completed' };
      mockPaymentsService.findById.mockResolvedValue(payment as any);

      const ctx: PaymentContext = { req: { headers: { 'x-user-id': 'user-2' } } };
      const result = await resolver.resolveReference({ __typename: 'Payment', id: 'pay-1' }, ctx);
      expect(result).toBeNull();
    });
  });
});

describe('UserPaymentMethodResolver', () => {
  let resolver: UserPaymentMethodResolver;
  const mockPaymentsService = {
    listSavedPaymentMethods: vi.fn(),
  } satisfies Pick<PaymentsService, 'listSavedPaymentMethods'>;

  beforeEach(() => {
    resolver = new UserPaymentMethodResolver(mockPaymentsService as unknown as PaymentsService);
    vi.clearAllMocks();
  });

  describe('paymentMethods field', () => {
    it('returns mapped payment methods for the owning user', async () => {
      const methods = [
        {
          id: 'pm-1',
          brand: 'visa',
          last4: '4242',
          expMonth: 12,
          expYear: 2025,
          isDefault: true,
        },
        {
          id: 'pm-2',
          brand: 'amex',
          last4: '3456',
          expMonth: 6,
          expYear: 2026,
          isDefault: false,
        },
      ];
      mockPaymentsService.listSavedPaymentMethods.mockResolvedValue(methods);

      const user = { __typename: 'User', id: 'user-123' };
      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.paymentMethods(user, ctx);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'pm-1',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2025,
        isDefault: true,
        label: 'VISA •••• 4242',
      });
      expect(result[1]).toEqual({
        id: 'pm-2',
        brand: 'amex',
        last4: '3456',
        expMonth: 6,
        expYear: 2026,
        isDefault: false,
        label: 'AMEX •••• 3456',
      });
    });

    it('returns empty list for non-owner requester', async () => {
      const methods = [
        {
          id: 'pm-1',
          brand: 'visa',
          last4: '4242',
          expMonth: 12,
          expYear: 2025,
          isDefault: true,
        },
      ];
      mockPaymentsService.listSavedPaymentMethods.mockResolvedValue(methods);

      const user = { __typename: 'User', id: 'user-123' };
      const ctx = { req: { headers: { 'x-user-id': 'other-user' } } };
      const result = await resolver.paymentMethods(user, ctx);

      expect(result).toEqual([]);
      expect(mockPaymentsService.listSavedPaymentMethods).not.toHaveBeenCalled();
    });

    it('returns empty list when requester identity is missing', async () => {
      const user = { __typename: 'User', id: 'user-123' };
      const ctx = { req: { headers: {} } };
      const result = await resolver.paymentMethods(user, ctx);

      expect(result).toEqual([]);
      expect(mockPaymentsService.listSavedPaymentMethods).not.toHaveBeenCalled();
    });
  });
});

describe('PaymentMethodMutationResolver', () => {
  let resolver: PaymentMethodMutationResolver;
  const mockPaymentsService = {
    charge: vi.fn(),
    requestRefund: vi.fn(),
    setDefaultSavedPaymentMethod: vi.fn(),
    deleteSavedPaymentMethod: vi.fn(),
    registerSavedPaymentMethod: vi.fn(),
  } satisfies Pick<
    PaymentsService,
    | 'charge'
    | 'requestRefund'
    | 'setDefaultSavedPaymentMethod'
    | 'deleteSavedPaymentMethod'
    | 'registerSavedPaymentMethod'
  >;

  beforeEach(() => {
    resolver = new PaymentMethodMutationResolver(mockPaymentsService as unknown as PaymentsService);
    vi.clearAllMocks();
  });

  describe('setDefaultPaymentMethod', () => {
    it('delegates to service and returns mapped method', async () => {
      const method = {
        id: 'pm-1',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2025,
        isDefault: true,
      };
      mockPaymentsService.setDefaultSavedPaymentMethod.mockResolvedValue(method);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.setDefaultPaymentMethod('pm-1', ctx);

      expect(mockPaymentsService.setDefaultSavedPaymentMethod).toHaveBeenCalledWith(
        'user-123',
        'pm-1',
      );
      expect(result).toEqual({
        id: 'pm-1',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2025,
        isDefault: true,
        label: 'VISA •••• 4242',
      });
    });

    it('throws ForbiddenException when requester identity is missing', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      const ctx = { req: { headers: {} } };

      await expect(resolver.setDefaultPaymentMethod('pm-1', ctx)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('createPayment', () => {
    it('delegates token payments to the service', async () => {
      const payment = {
        id: 'pay-1',
        orderId: 'order-1',
        userId: 'user-123',
        amount: 5000,
        currency: 'usd',
        status: 'completed',
        createdAt: new Date().toISOString(),
      };
      mockPaymentsService.charge.mockResolvedValue(payment);

      const ctx = {
        req: {
          headers: {
            'x-user-id': 'user-123',
            'x-user-id-sig': 'sig-123',
          },
        },
      };

      const result = await resolver.createPayment(
        { orderId: 'order-1', token: 'pm_card_visa' },
        ctx,
      );

      expect(mockPaymentsService.charge).toHaveBeenCalledWith({
        orderId: 'order-1',
        userId: 'user-123',
        token: 'pm_card_visa',
        savedPaymentMethodId: undefined,
        userIdSig: 'sig-123',
      });

      expect(result).toEqual({ ...payment, status: 'CAPTURED' });
    });

    it('delegates saved-payment-method charges to the service', async () => {
      const payment = {
        id: 'pay-2',
        orderId: 'order-2',
        userId: 'user-123',
        amount: 4200,
        currency: 'usd',
        status: 'completed',
        createdAt: new Date().toISOString(),
      };
      mockPaymentsService.charge.mockResolvedValue(payment);

      const ctx = {
        req: {
          headers: {
            'x-user-id': 'user-123',
            'x-user-id-sig': 'sig-456',
          },
        },
      };

      const result = await resolver.createPayment(
        {
          orderId: 'order-2',
          savedPaymentMethodId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        ctx,
      );

      expect(mockPaymentsService.charge).toHaveBeenCalledWith({
        orderId: 'order-2',
        userId: 'user-123',
        token: undefined,
        savedPaymentMethodId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        userIdSig: 'sig-456',
      });
      expect(result).toEqual({ ...payment, status: 'CAPTURED' });
    });

    it('throws ForbiddenException when requester identity is missing', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      const ctx = { req: { headers: {} } };

      await expect(
        resolver.createPayment({ orderId: 'order-1', token: 'pm_card_visa' }, ctx),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('requestRefund', () => {
    it('delegates refund request to the service', async () => {
      const refund = {
        payment: {
          id: 'pay-2',
          orderId: 'order-2',
          userId: 'user-123',
          amount: 4200,
          currency: 'usd',
          status: 'refunded',
          createdAt: new Date().toISOString(),
        },
        refundId: 'refund-1',
        status: 'REQUESTED',
      };
      mockPaymentsService.requestRefund.mockResolvedValue(refund);

      const ctx = {
        req: {
          headers: {
            'x-user-id': 'user-123',
            'x-user-id-sig': 'sig-456',
          },
        },
      };

      const result = await resolver.requestRefund(
        { orderId: 'order-2', reason: 'Unable to attend' },
        ctx,
      );

      expect(mockPaymentsService.requestRefund).toHaveBeenCalledWith({
        orderId: 'order-2',
        reason: 'Unable to attend',
        userId: 'user-123',
        userIdSig: 'sig-456',
      });
      expect(result).toEqual({
        payment: { ...refund.payment, status: 'REFUNDED' },
        refundId: 'refund-1',
        status: 'REQUESTED',
      });
    });

    it('throws ForbiddenException when requester identity is missing', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      const ctx = { req: { headers: {} } };

      await expect(
        resolver.requestRefund({ orderId: 'order-1', reason: 'Cannot go' }, ctx),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deletePaymentMethod', () => {
    it('delegates to service and returns true', async () => {
      mockPaymentsService.deleteSavedPaymentMethod.mockResolvedValue(undefined);

      const ctx = { req: { headers: { 'x-user-id': 'user-123' } } };
      const result = await resolver.deletePaymentMethod('pm-1', ctx);

      expect(mockPaymentsService.deleteSavedPaymentMethod).toHaveBeenCalledWith('user-123', 'pm-1');
      expect(result).toBe(true);
    });

    it('throws ForbiddenException when requester identity is missing', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      const ctx = { req: { headers: {} } };

      await expect(resolver.deletePaymentMethod('pm-1', ctx)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('registerPaymentMethod', () => {
    it('delegates to service with consent context and returns mapped method', async () => {
      const method = {
        id: 'pm-new',
        brand: 'mastercard',
        last4: '5555',
        expMonth: 3,
        expYear: 2027,
        isDefault: false,
      };
      mockPaymentsService.registerSavedPaymentMethod.mockResolvedValue(method);

      const ctx = {
        req: {
          headers: {
            'x-user-id': 'user-123',
            'x-consent-source': 'mobile-app',
            'user-agent': 'MyApp/1.0',
            'x-forwarded-for': '192.168.1.1',
          },
        },
      };
      const input = {
        providerPaymentMethodId: 'pm_external_123',
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: '1.0',
      };
      const result = await resolver.registerPaymentMethod(input, ctx);

      expect(mockPaymentsService.registerSavedPaymentMethod).toHaveBeenCalledWith(
        'user-123',
        {
          providerPaymentMethodId: 'pm_external_123',
          setAsDefault: false,
          consentAccepted: true,
          consentVersion: '1.0',
        },
        {
          source: 'mobile-app',
          userAgent: 'MyApp/1.0',
          ipAddress: '192.168.1.1',
        },
      );
      expect(result).toEqual({
        id: 'pm-new',
        brand: 'mastercard',
        last4: '5555',
        expMonth: 3,
        expYear: 2027,
        isDefault: false,
        label: 'MASTERCARD •••• 5555',
      });
    });

    it('extracts consent headers correctly and normalizes defaults', async () => {
      const method = {
        id: 'pm-new',
        brand: 'visa',
        last4: '1111',
        expMonth: 1,
        expYear: 2028,
        isDefault: false,
      };
      mockPaymentsService.registerSavedPaymentMethod.mockResolvedValue(method);

      const ctx = {
        req: {
          headers: {
            'x-user-id': 'user-456',
          },
        },
      };
      const input = {
        providerPaymentMethodId: 'pm_xyz',
        consentAccepted: true,
        consentVersion: '2.0',
      };
      await resolver.registerPaymentMethod(input, ctx);

      expect(mockPaymentsService.registerSavedPaymentMethod).toHaveBeenCalledWith(
        'user-456',
        {
          providerPaymentMethodId: 'pm_xyz',
          setAsDefault: false,
          consentAccepted: true,
          consentVersion: '2.0',
        },
        {
          source: 'unknown',
          userAgent: undefined,
          ipAddress: undefined,
        },
      );
    });

    it('throws ForbiddenException when requester identity is missing', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      const ctx = { req: { headers: {} } };
      const input = {
        providerPaymentMethodId: 'pm_123',
        consentAccepted: true,
        consentVersion: '1.0',
      };

      await expect(resolver.registerPaymentMethod(input, ctx)).rejects.toThrow(ForbiddenException);
    });
  });
});
