import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_STATUS } from '../../database/schema';
import type { Payment, SavedPaymentMethod } from '../../database/schema';

type MockFn = ReturnType<typeof vi.fn>;
type PaymentsServiceMock = {
  charge: MockFn;
  findById: MockFn;
  registerSavedPaymentMethod: MockFn;
  listSavedPaymentMethods: MockFn;
  setDefaultSavedPaymentMethod: MockFn;
  deleteSavedPaymentMethod: MockFn;
  processOrderCreatedEvent: MockFn;
  constructWebhookEvent: MockFn;
  handleStripeEvent: MockFn;
  failStripePayment: MockFn;
  completeStripePayment: MockFn;
};

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-uuid-1',
    orderId: 'order-uuid-1',
    userId: 'user-uuid-1',
    amount: 1000,
    currency: 'usd',
    status: PAYMENT_STATUS.COMPLETED,
    stripePaymentIntentId: 'pi_abc',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  return {
    charge: vi.fn(),
    findById: vi.fn(),
    registerSavedPaymentMethod: vi.fn(),
    listSavedPaymentMethods: vi.fn(),
    setDefaultSavedPaymentMethod: vi.fn(),
    deleteSavedPaymentMethod: vi.fn(),
    processOrderCreatedEvent: vi.fn(),
    constructWebhookEvent: vi.fn(),
    handleStripeEvent: vi.fn(),
    failStripePayment: vi.fn(),
    completeStripePayment: vi.fn(),
  };
}

function makeSavedMethod(overrides: Partial<SavedPaymentMethod> = {}): SavedPaymentMethod {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'user-1',
    paymentCustomerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    provider: 'stripe',
    providerPaymentMethodId: 'pm_mock_card_4242',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2099,
    fingerprint: 'fp_mock_4242',
    isDefault: true,
    consentGivenAt: new Date(),
    consentVersion: 'settings-card-save-v1',
    consentSource: 'settings-ui',
    consentIpHash: 'hashed-ip',
    consentUserAgent: 'vitest',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('PaymentsController.charge', () => {
  let service: PaymentsServiceMock;
  let controller: PaymentsController;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentsController(service as unknown as PaymentsService);
  });

  it('should throw BadRequestException when X-User-Id header is missing', async () => {
    await expect(
      controller.charge(undefined, { orderId: 'order-1', token: 'pm_x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should return created payment when charge succeeds', async () => {
    const payment = makePayment();
    service.charge.mockResolvedValue(payment);

    const result = await controller.charge('user-1', {
      orderId: 'order-1',
      token: 'pm_x',
    });

    expect(service.charge).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', userId: 'user-1', token: 'pm_x' }),
    );
    expect(result).toEqual({ payment });
  });

  it('should propagate service exceptions up to the global exception filter', async () => {
    service.charge.mockRejectedValue(new InternalServerErrorException('fail'));

    await expect(
      controller.charge('user-1', { orderId: 'order-1', token: 'pm_bad' }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});

describe('PaymentsController.findOne', () => {
  let service: PaymentsServiceMock;
  let controller: PaymentsController;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentsController(service as unknown as PaymentsService);
  });

  it('should return payment when authenticated owner requests it', async () => {
    const payment = makePayment({ userId: 'user-uuid-1' });
    service.findById.mockResolvedValue(payment);

    const result = await controller.findOne('pay-uuid-1', 'user-uuid-1');
    expect(result).toEqual({ payment });
  });

  it('should throw UnauthorizedException when X-User-Id header is missing', async () => {
    await expect(controller.findOne('pay-uuid-1', undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(service.findById).not.toHaveBeenCalled();
  });

  it('should throw NotFoundException when payment does not exist', async () => {
    service.findById.mockResolvedValue(null);

    await expect(controller.findOne('bad-id', 'user-uuid-1')).rejects.toThrow(NotFoundException);
  });

  it('should throw ForbiddenException when user does not own the payment', async () => {
    const payment = makePayment({ userId: 'owner-uuid' });
    service.findById.mockResolvedValue(payment);

    await expect(controller.findOne('pay-uuid-1', 'attacker-uuid')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('PaymentsController saved payment methods', () => {
  let service: PaymentsServiceMock;
  let controller: PaymentsController;

  beforeEach(() => {
    service = makeService();
    controller = new PaymentsController(service as unknown as PaymentsService);
  });

  it('should register a saved payment method when user id is present', async () => {
    const savedMethod = makeSavedMethod();
    service.registerSavedPaymentMethod.mockResolvedValue(savedMethod);

    const req = {
      headers: {
        'x-consent-source': 'settings-ui',
        'x-forwarded-for': '10.0.0.1',
        'user-agent': 'Mozilla/5.0',
      },
      ip: '127.0.0.1',
    };

    const result = await controller.registerSavedPaymentMethod(
      'user-1',
      {
        providerPaymentMethodId: 'pm_mock_card_4242',
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      },
      req as never,
    );

    expect(service.registerSavedPaymentMethod).toHaveBeenCalledWith(
      'user-1',
      {
        providerPaymentMethodId: 'pm_mock_card_4242',
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      },
      {
        source: 'settings-ui',
        ipAddress: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
      },
    );
    expect(result).toEqual({
      paymentMethod: {
        id: savedMethod.id,
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2099,
        isDefault: true,
        label: 'VISA •••• 4242',
      },
    });
  });

  it('should throw BadRequestException when register is called without X-User-Id', async () => {
    await expect(
      controller.registerSavedPaymentMethod(
        undefined,
        {
          providerPaymentMethodId: 'pm_mock_card_1111',
          consentAccepted: true,
          consentVersion: 'settings-card-save-v1',
        },
        {} as never,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should list saved payment methods for authenticated user', async () => {
    service.listSavedPaymentMethods.mockResolvedValue([
      makeSavedMethod({ id: 'method-1', isDefault: false, last4: '1111' }),
    ]);

    const result = await controller.listSavedPaymentMethods('user-1');
    expect(service.listSavedPaymentMethods).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({
      paymentMethods: [
        {
          id: 'method-1',
          brand: 'visa',
          last4: '1111',
          expMonth: 12,
          expYear: 2099,
          isDefault: false,
          label: 'VISA •••• 1111',
        },
      ],
    });
  });

  it('should set default saved payment method', async () => {
    service.setDefaultSavedPaymentMethod.mockResolvedValue(
      makeSavedMethod({ id: 'method-2', isDefault: true, last4: '2222' }),
    );

    const result = await controller.setDefaultSavedPaymentMethod('user-1', {
      id: 'method-2',
    });

    expect(service.setDefaultSavedPaymentMethod).toHaveBeenCalledWith('user-1', 'method-2');
    expect(result).toEqual({
      paymentMethod: {
        id: 'method-2',
        brand: 'visa',
        last4: '2222',
        expMonth: 12,
        expYear: 2099,
        isDefault: true,
        label: 'VISA •••• 2222',
      },
    });
  });

  it('should delete saved payment method', async () => {
    service.deleteSavedPaymentMethod.mockResolvedValue(undefined);

    await expect(
      controller.deleteSavedPaymentMethod('user-1', { id: 'method-3' }),
    ).resolves.toBeUndefined();

    expect(service.deleteSavedPaymentMethod).toHaveBeenCalledWith('user-1', 'method-3');
  });
});
