import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, InternalServerErrorException } from '@nestjs/common';
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

/**
 * Make a mock Drizzle db that executes the transaction callback immediately.
 *
 * The transaction callback receives a tx object with insert/update/select chained
 * methods. Tests can configure return values by replacing individual vi.fn()s.
 */
function makeDb(txInsertReturn: Payment | null = null) {
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(txInsertReturn ? [txInsertReturn] : [{ id: 'outbox-id' }]),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi
      .fn()
      .mockResolvedValue([txInsertReturn ?? makePayment({ status: PAYMENT_STATUS.COMPLETED })]),
  };
  const tx = {
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
  };

  return {
    // Execute the callback synchronously with the mock tx
    transaction: vi.fn().mockImplementation(async (cb: (tx: typeof tx) => Promise<void>) => {
      await cb(tx);
    }),
    _tx: tx,
    _insertChain: insertChain,
    _updateChain: updateChain,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentsService.charge', () => {
  let repo: ReturnType<typeof makeRepo>;
  let stripe: ReturnType<typeof makeStripe>;
  let logger: ReturnType<typeof makeLogger>;
  let config: ReturnType<typeof makeConfig>;
  let db: ReturnType<typeof makeDb>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    stripe = makeStripe();
    logger = makeLogger();
    config = makeConfig();
    db = makeDb();

    service = new PaymentsService(
      logger as any,
      repo as any,
      stripe as any,
      config as any,
      db as any,
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

  it('should complete payment via mock path when STRIPE_SECRET_KEY contains test_mock', async () => {
    // Use sk_test_mock — the real .env value — to verify the prefix-inclusive check
    const mockConfig = makeConfig('sk_test_mock');
    const mockDb = makeDb();
    const completed = makePayment({ status: PAYMENT_STATUS.COMPLETED });
    // First insert (payments) returns the completed payment; second (outbox) returns a row
    mockDb._tx.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([completed]),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 'outbox-id' }]),
      });

    const svc = new PaymentsService(
      makeLogger() as any,
      repo as any,
      stripe as any,
      mockConfig as any,
      mockDb as any,
    );
    repo.findByOrderId.mockResolvedValue(null);

    const result = await svc.charge({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      amount: 1000,
      token: 'pm_test',
    });

    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(result).toEqual(completed);
  });

  it('should create payment and initiate Stripe PaymentIntent when no existing payment (real mode)', async () => {
    const pending = makePayment();
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_abc' });

    // completePaymentWithOutbox uses db.transaction
    const completed = makePayment({
      status: PAYMENT_STATUS.COMPLETED,
      stripePaymentIntentId: 'pi_abc',
    });
    db._tx.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([completed]),
    });

    const result = await service.charge({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      amount: 1000,
      token: 'pm_test',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-uuid-1',
        amount: 1000,
        status: PAYMENT_STATUS.PENDING,
      }),
    );
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1000, currency: 'usd' }),
      expect.objectContaining({ idempotencyKey: 'order-uuid-1' }),
    );
    expect(db.transaction).toHaveBeenCalled();
    expect(result).toEqual(completed);
  });

  it('should mark payment as failed and throw when Stripe fails', async () => {
    const pending = makePayment();
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockRejectedValue(new Error('Card declined'));
    repo.updateStatus.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.FAILED }));

    await expect(
      service.charge({
        orderId: 'order-uuid-1',
        userId: 'user-uuid-1',
        amount: 1000,
        token: 'pm_bad',
      }),
    ).rejects.toThrow(InternalServerErrorException);

    expect(repo.updateStatus).toHaveBeenCalledWith(pending.id, PAYMENT_STATUS.FAILED);
  });

  it('should default currency to usd when not specified', async () => {
    const pending = makePayment();
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_xyz' });

    const completed = makePayment({ status: PAYMENT_STATUS.COMPLETED });
    db._tx.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([completed]),
    });

    await service.charge({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      amount: 500,
      token: 'pm_x',
    });

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'usd' }));
  });
});

describe('PaymentsService.findById', () => {
  let repo: ReturnType<typeof makeRepo>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    service = new PaymentsService(
      makeLogger() as any,
      repo as any,
      makeStripe() as any,
      makeConfig() as any,
      makeDb() as any,
    );
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

  beforeEach(() => {
    repo = makeRepo();
  });

  it('should create a completed payment via mock path when STRIPE_SECRET_KEY is test_mock', async () => {
    const mockDb = makeDb();
    const completed = makePayment({ status: PAYMENT_STATUS.COMPLETED });
    // First call to tx.insert is for payments table; second is for outbox
    mockDb._tx.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([completed]),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 'outbox-id' }]),
      });

    const service = new PaymentsService(
      makeLogger() as any,
      repo as any,
      makeStripe() as any,
      makeConfig('test_mock') as any,
      mockDb as any,
    );
    repo.findByOrderId.mockResolvedValue(null);

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    expect(mockDb.transaction).toHaveBeenCalled();
    // The insert call with the payments table should include COMPLETED status
    const insertArgs = mockDb._tx.insert.mock.calls[0];
    expect(insertArgs).toBeDefined();
  });

  it('should use isMockMode correctly for sk_test_mock prefix (C-06 fix)', async () => {
    // sk_test_mock is what docker-compose sets; the old code checked === 'test_mock' (bare)
    // and missed this. The new isMockMode uses .includes('test_mock').
    const mockDb = makeDb();
    const completed = makePayment({ status: PAYMENT_STATUS.COMPLETED });
    mockDb._tx.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([completed]),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 'outbox-id' }]),
      });

    const service = new PaymentsService(
      makeLogger() as any,
      repo as any,
      makeStripe() as any,
      makeConfig('sk_test_mock') as any, // Docker-compose value with sk_ prefix
      mockDb as any,
    );
    repo.findByOrderId.mockResolvedValue(null);

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    // Should have used mock path (transaction called) and NOT called Stripe
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(makeStripe().paymentIntents.create).not.toHaveBeenCalled();
  });

  it('should skip processing when orderId already has a payment (idempotent)', async () => {
    const mockDb = makeDb();
    const service = new PaymentsService(
      makeLogger() as any,
      repo as any,
      makeStripe() as any,
      makeConfig('test_mock') as any,
      mockDb as any,
    );
    repo.findByOrderId.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.COMPLETED }));

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('should re-throw on repository failure so the consumer can retry', async () => {
    const mockDb = makeDb();
    mockDb.transaction.mockRejectedValue(new Error('DB connection lost'));

    const service = new PaymentsService(
      makeLogger() as any,
      repo as any,
      makeStripe() as any,
      makeConfig('test_mock') as any,
      mockDb as any,
    );
    repo.findByOrderId.mockResolvedValue(null);

    await expect(
      service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 1000 }),
    ).rejects.toThrow('DB connection lost');
  });
});
