import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PAYMENT_STATUS } from '../../database/schema';
import type { Payment } from '../../database/schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-uuid-1',
    orderId: 'order-uuid-1',
    userId: 'user-uuid-1',
    amount: 1000,
    currency: 'usd',
    status: PAYMENT_STATUS.PENDING,
    stripePaymentIntentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRepo() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByOrderId: vi.fn(),
    updateStatus: vi.fn(),
  };
}

function makeStripe() {
  return {
    paymentIntents: {
      create: vi.fn(),
    },
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeConfig(key = 'sk_test_real') {
  return {
    get: vi.fn().mockReturnValue(key),
    getOrThrow: vi.fn().mockReturnValue(key),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentsService.charge', () => {
  let repo: ReturnType<typeof makeRepo>;
  let stripe: ReturnType<typeof makeStripe>;
  let logger: ReturnType<typeof makeLogger>;
  let config: ReturnType<typeof makeConfig>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    stripe = makeStripe();
    logger = makeLogger();
    config = makeConfig();

    service = new PaymentsService(
      logger as any,
      repo as any,
      stripe as any,
      config as any,
    );
  });

  it('should return existing payment when orderId already has a payment (idempotent)', async () => {
    const existing = makePayment({ status: PAYMENT_STATUS.COMPLETED });
    repo.findByOrderId.mockResolvedValue(existing);

    const result = await service.charge({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      amount: 1000,
      token: 'pm_test',
    });

    expect(result).toEqual(existing);
    expect(repo.create).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('should create payment and complete it via Stripe when no existing payment', async () => {
    const pending = makePayment();
    const completed = makePayment({ status: PAYMENT_STATUS.COMPLETED, stripePaymentIntentId: 'pi_abc' });

    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_abc' });
    repo.updateStatus.mockResolvedValue(completed);

    const result = await service.charge({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      amount: 1000,
      token: 'pm_test',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-uuid-1', amount: 1000, status: PAYMENT_STATUS.PENDING }),
    );
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1000, currency: 'usd' }),
    );
    expect(repo.updateStatus).toHaveBeenCalledWith(pending.id, PAYMENT_STATUS.COMPLETED, 'pi_abc');
    expect(result).toEqual(completed);
  });

  it('should mark payment as failed and throw InternalServerErrorException when Stripe fails', async () => {
    const pending = makePayment();
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockRejectedValue(new Error('Card declined'));
    repo.updateStatus.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.FAILED }));

    await expect(
      service.charge({ orderId: 'order-uuid-1', userId: 'user-uuid-1', amount: 1000, token: 'pm_bad' }),
    ).rejects.toThrow(InternalServerErrorException);

    expect(repo.updateStatus).toHaveBeenCalledWith(pending.id, PAYMENT_STATUS.FAILED);
  });

  it('should default currency to usd when not specified', async () => {
    const pending = makePayment();
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_xyz' });
    repo.updateStatus.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.COMPLETED }));

    await service.charge({ orderId: 'order-uuid-1', userId: 'user-uuid-1', amount: 500, token: 'pm_x' });

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'usd' }));
  });
});

describe('PaymentsService.findById', () => {
  let repo: ReturnType<typeof makeRepo>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    service = new PaymentsService(makeLogger() as any, repo as any, makeStripe() as any, makeConfig() as any);
  });

  it('should return payment when it exists', async () => {
    const payment = makePayment({ status: PAYMENT_STATUS.COMPLETED });
    repo.findById.mockResolvedValue(payment);

    const result = await service.findById('pay-uuid-1');
    expect(result).toEqual(payment);
  });

  it('should throw NotFoundException when payment does not exist', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.findById('non-existent')).rejects.toThrow(NotFoundException);
  });
});

describe('PaymentsService.processOrderCreatedEvent', () => {
  let repo: ReturnType<typeof makeRepo>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    service = new PaymentsService(
      makeLogger() as any,
      repo as any,
      makeStripe() as any,
      makeConfig('test_mock') as any,
    );
  });

  it('should create a completed payment when STRIPE_SECRET_KEY is test_mock', async () => {
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.COMPLETED }));

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PAYMENT_STATUS.COMPLETED,
        stripePaymentIntentId: 'mock_pi_order-1',
      }),
    );
  });

  it('should skip processing when orderId already has a payment (idempotent)', async () => {
    repo.findByOrderId.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.COMPLETED }));

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    expect(repo.create).not.toHaveBeenCalled();
  });

  it('should re-throw on repository failure so the consumer can retry', async () => {
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockRejectedValue(new Error('DB connection lost'));

    await expect(
      service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 1000 }),
    ).rejects.toThrow('DB connection lost');
  });
});
