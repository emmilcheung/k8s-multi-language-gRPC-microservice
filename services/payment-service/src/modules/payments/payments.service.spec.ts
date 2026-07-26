import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import Stripe from 'stripe';
import { PaymentsService } from './payments.service';
import { PAYMENT_STATUS } from '../../database/schema';
import type { Payment, PaymentCustomer, SavedPaymentMethod } from '../../database/schema';
import type { OrderSnapshot } from './order-service.client';
import { PaymentsRepository } from './payments.repository';
import { OrderServiceClient } from './order-service.client';
import { type DrizzleDB } from '../../database/database.module';
import type { PaymentVaultProvider } from './payment-vault.provider';

type RepoMock = Pick<
  PaymentsRepository,
  | 'create'
  | 'findById'
  | 'findByOrderId'
  | 'updateStatus'
  | 'findPaymentCustomerByUserId'
  | 'createPaymentCustomer'
  | 'findSavedPaymentMethodById'
  | 'findSavedPaymentMethodByProviderId'
  | 'listSavedPaymentMethodsByUserId'
  | 'createSavedPaymentMethod'
  | 'setDefaultSavedPaymentMethod'
  | 'softDeleteSavedPaymentMethod'
  | 'createRefund'
  | 'findActiveRefundByOrderId'
>;
type OrderServiceClientMock = Pick<OrderServiceClient, 'getOrderSnapshot'>;
type LoggerMock = Pick<PinoLogger, 'info' | 'warn' | 'error' | 'debug'>;
type ConfigMock = Pick<ConfigService, 'get' | 'getOrThrow'>;
type PaymentVaultProviderMock = Pick<
  PaymentVaultProvider,
  'ensureCustomer' | 'attachPaymentMethod' | 'detachPaymentMethod'
>;
type StripeMock = {
  paymentIntents: {
    create: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
  };
  webhooks: {
    constructEvent: ReturnType<typeof vi.fn>;
  };
};
type MockTx = {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
type DbMock = {
  transaction: ReturnType<typeof vi.fn>;
  _tx: MockTx;
  _insertChain: {
    values: ReturnType<typeof vi.fn>;
    returning: ReturnType<typeof vi.fn>;
  };
  _updateChain: {
    set: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    returning: ReturnType<typeof vi.fn>;
  };
};

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
    findPaymentCustomerByUserId: vi.fn(),
    createPaymentCustomer: vi.fn(),
    findSavedPaymentMethodById: vi.fn(),
    findSavedPaymentMethodByProviderId: vi.fn(),
    listSavedPaymentMethodsByUserId: vi.fn(),
    createSavedPaymentMethod: vi.fn(),
    setDefaultSavedPaymentMethod: vi.fn(),
    softDeleteSavedPaymentMethod: vi.fn(),
    createRefund: vi.fn(),
    findActiveRefundByOrderId: vi.fn(),
  };
}

function makePaymentCustomer(overrides: Partial<PaymentCustomer> = {}): PaymentCustomer {
  return {
    id: 'c1111111-1111-4111-8111-111111111111',
    userId: 'user-uuid-1',
    provider: 'stripe',
    providerCustomerId: 'cus_mock_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSavedPaymentMethod(overrides: Partial<SavedPaymentMethod> = {}): SavedPaymentMethod {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'user-uuid-1',
    paymentCustomerId: 'c1111111-1111-4111-8111-111111111111',
    provider: 'stripe',
    providerPaymentMethodId: 'pm_saved_1',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2099,
    fingerprint: 'fp_saved_1',
    isDefault: false,
    consentGivenAt: new Date(),
    consentVersion: 'settings-card-save-v1',
    consentSource: 'settings-ui',
    consentIpHash: 'hashed-ip',
    consentUserAgent: 'vitest-agent',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function makePaymentVaultProvider() {
  return {
    ensureCustomer: vi.fn(),
    attachPaymentMethod: vi.fn(),
    detachPaymentMethod: vi.fn(),
  };
}

function makeStripe() {
  return {
    paymentIntents: {
      create: vi.fn(),
      confirm: vi.fn(),
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  };
}

function makeOrderSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    status: 'created',
    amount: 1000,
    currency: 'usd',
    ...overrides,
  };
}

function makeOrderServiceClient() {
  return {
    getOrderSnapshot: vi.fn(),
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
    transaction: vi.fn().mockImplementation(async (cb: (tx: MockTx) => Promise<void>) => {
      await cb(tx);
    }),
    _tx: tx,
    _insertChain: insertChain,
    _updateChain: updateChain,
  };
}

function createService(params: {
  logger: LoggerMock;
  repo: RepoMock;
  orderServiceClient: OrderServiceClientMock;
  stripe: StripeMock;
  paymentVaultProvider: PaymentVaultProviderMock;
  config: ConfigMock;
  db: DbMock;
}): PaymentsService {
  return new PaymentsService(
    params.logger as unknown as PinoLogger,
    params.repo as unknown as PaymentsRepository,
    params.orderServiceClient as unknown as OrderServiceClient,
    params.stripe as unknown as Stripe,
    params.paymentVaultProvider,
    params.config as unknown as ConfigService,
    params.db as unknown as DrizzleDB,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentsService.charge', () => {
  let repo: ReturnType<typeof makeRepo>;
  let stripe: ReturnType<typeof makeStripe>;
  let paymentVaultProvider: ReturnType<typeof makePaymentVaultProvider>;
  let logger: ReturnType<typeof makeLogger>;
  let config: ReturnType<typeof makeConfig>;
  let db: ReturnType<typeof makeDb>;
  let orderServiceClient: ReturnType<typeof makeOrderServiceClient>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    stripe = makeStripe();
    paymentVaultProvider = makePaymentVaultProvider();
    logger = makeLogger();
    config = makeConfig();
    db = makeDb();
    orderServiceClient = makeOrderServiceClient();

    service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config,
      db,
    });
  });

  it('should return existing payment when orderId already has a payment (idempotent)', async () => {
    const existing = makePayment({ status: PAYMENT_STATUS.COMPLETED });
    repo.findByOrderId.mockResolvedValue(existing);

    const result = await service.charge({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      token: 'pm_test',
    });

    expect(result).toEqual(existing);
    expect(repo.create).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(orderServiceClient.getOrderSnapshot).not.toHaveBeenCalled();
  });

  it('should reject a duplicate payment request from a different user', async () => {
    repo.findByOrderId.mockResolvedValue(makePayment({ userId: 'owner-uuid' }));

    await expect(
      service.charge({
        orderId: 'order-uuid-1',
        userId: 'attacker-uuid',
        token: 'pm_test',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should continue an existing pending payment instead of returning it unchanged', async () => {
    const existingPending = makePayment({
      status: PAYMENT_STATUS.PENDING,
      stripePaymentIntentId: 'pi_pending',
    });
    const completed = makePayment({
      status: PAYMENT_STATUS.COMPLETED,
      stripePaymentIntentId: 'pi_pending',
    });
    repo.findByOrderId.mockResolvedValue(existingPending);
    stripe.paymentIntents.confirm.mockResolvedValue({
      id: 'pi_pending',
      status: 'succeeded',
    });
    db._tx.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([completed]),
    });

    const result = await service.charge({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      token: 'pm_test',
    });

    expect(stripe.paymentIntents.confirm).toHaveBeenCalledWith('pi_pending', {
      payment_method: 'pm_test',
    });
    expect(result).toEqual(completed);
    expect(orderServiceClient.getOrderSnapshot).not.toHaveBeenCalled();
  });

  it('should complete payment via mock path when STRIPE_SECRET_KEY contains test_mock', async () => {
    const mockConfig = makeConfig('sk_test_mock');
    const mockDb = makeDb();
    const completed = makePayment({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      status: PAYMENT_STATUS.COMPLETED,
      stripePaymentIntentId: 'mock_pi_11111111-1111-4111-8111-111111111111',
    });
    mockDb._tx.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([completed]),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 'outbox-id' }]),
      });

    const svc = createService({
      logger: makeLogger(),
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: mockConfig,
      db: mockDb,
    });
    repo.findByOrderId.mockResolvedValue(null);
    orderServiceClient.getOrderSnapshot.mockResolvedValue(makeOrderSnapshot());

    const result = await svc.charge({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      token: 'pm_test',
    });

    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(mockDb.transaction).toHaveBeenCalledOnce();
    expect(result).toEqual(completed);
  });

  it('should fail payment via mock path when token requests a declined outcome', async () => {
    const mockConfig = makeConfig('sk_test_mock');
    const mockDb = makeDb();
    const failed = makePayment({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      status: PAYMENT_STATUS.FAILED,
      stripePaymentIntentId: 'mock_pi_failed_11111111-1111-4111-8111-111111111111',
    });
    const mockLogger = makeLogger();
    mockDb._tx.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([failed]),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 'outbox-id' }]),
      });

    const svc = createService({
      logger: mockLogger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: mockConfig,
      db: mockDb,
    });
    repo.findByOrderId.mockResolvedValue(null);
    orderServiceClient.getOrderSnapshot.mockResolvedValue(makeOrderSnapshot());

    await expect(
      svc.charge({
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        token: 'pm_mock_declined',
      }),
    ).rejects.toThrow(InternalServerErrorException);

    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(mockDb.transaction).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.charge.failed',
        orderId: '11111111-1111-4111-8111-111111111111',
        mode: 'mock',
        reason: 'Mock payment declined',
      }),
      'Payment audit event',
    );
  });

  it('should create payment and initiate Stripe PaymentIntent using authoritative order data', async () => {
    const pending = makePayment({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      amount: 2750,
    });
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_abc', status: 'succeeded' });
    orderServiceClient.getOrderSnapshot.mockResolvedValue(
      makeOrderSnapshot({
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        amount: 2750,
      }),
    );

    const completed = makePayment({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      amount: 2750,
      status: PAYMENT_STATUS.COMPLETED,
      stripePaymentIntentId: 'pi_abc',
    });
    db._tx.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([completed]),
    });

    const result = await service.charge({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      token: 'pm_test',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: '11111111-1111-4111-8111-111111111111',
        amount: 2750,
        currency: 'usd',
        status: PAYMENT_STATUS.PENDING,
      }),
    );
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2750, currency: 'usd' }),
      expect.objectContaining({ idempotencyKey: '11111111-1111-4111-8111-111111111111' }),
    );
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.charge.attempted',
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
      }),
      'Payment audit event',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.charge.completed',
        orderId: '11111111-1111-4111-8111-111111111111',
        paymentId: pending.id,
        stripeIntentId: 'pi_abc',
      }),
      'Payment audit event',
    );
    expect(result).toEqual(completed);
  });

  it('should keep payment pending when Stripe returns a non-terminal status', async () => {
    const pending = makePayment();
    const pendingWithIntent = makePayment({
      stripePaymentIntentId: 'pi_pending',
      status: PAYMENT_STATUS.PENDING,
    });
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    repo.updateStatus.mockResolvedValue(pendingWithIntent);
    stripe.paymentIntents.create.mockResolvedValue({
      id: 'pi_pending',
      status: 'processing',
    });
    orderServiceClient.getOrderSnapshot.mockResolvedValue(makeOrderSnapshot());

    const result = await service.charge({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      token: 'pm_processing',
    });

    expect(repo.updateStatus).toHaveBeenCalledWith(
      pending.id,
      PAYMENT_STATUS.PENDING,
      'pi_pending',
    );
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual(pendingWithIntent);
  });

  it('should mark payment as failed when Stripe returns a terminal failure status', async () => {
    const pending = makePayment();
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    repo.updateStatus.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.FAILED }));
    stripe.paymentIntents.create.mockResolvedValue({
      id: 'pi_failed',
      status: 'requires_payment_method',
    });
    orderServiceClient.getOrderSnapshot.mockResolvedValue(makeOrderSnapshot());

    await expect(
      service.charge({
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        token: 'pm_bad',
      }),
    ).rejects.toThrow(InternalServerErrorException);

    expect(repo.updateStatus).toHaveBeenCalledWith(pending.id, PAYMENT_STATUS.FAILED, 'pi_failed');
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('should mark payment as failed and throw when Stripe fails', async () => {
    const pending = makePayment();
    repo.findByOrderId.mockResolvedValue(null);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockRejectedValue(new Error('Card declined'));
    repo.updateStatus.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.FAILED }));
    orderServiceClient.getOrderSnapshot.mockResolvedValue(makeOrderSnapshot());

    await expect(
      service.charge({
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        token: 'pm_bad',
      }),
    ).rejects.toThrow(InternalServerErrorException);

    expect(repo.updateStatus).toHaveBeenCalledWith(pending.id, PAYMENT_STATUS.FAILED);
  });

  it('should reject orders that are not in a payable state', async () => {
    repo.findByOrderId.mockResolvedValue(null);
    orderServiceClient.getOrderSnapshot.mockResolvedValue(
      makeOrderSnapshot({ status: 'cancelled' }),
    );

    await expect(
      service.charge({
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        token: 'pm_x',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should resolve provider payment method when charging with savedPaymentMethodId', async () => {
    const pending = makePayment({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      amount: 2750,
    });
    const saved = makeSavedPaymentMethod({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId: '22222222-2222-4222-8222-222222222222',
      providerPaymentMethodId: 'pm_saved_provider_1',
      deletedAt: null,
    });

    repo.findByOrderId.mockResolvedValue(null);
    repo.findSavedPaymentMethodById.mockResolvedValue(saved);
    repo.create.mockResolvedValue(pending);
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_saved', status: 'succeeded' });
    orderServiceClient.getOrderSnapshot.mockResolvedValue(
      makeOrderSnapshot({
        orderId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        amount: 2750,
      }),
    );

    const completed = makePayment({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      amount: 2750,
      status: PAYMENT_STATUS.COMPLETED,
      stripePaymentIntentId: 'pi_saved',
    });
    db._tx.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([completed]),
    });

    await service.charge({
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      savedPaymentMethodId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method: 'pm_saved_provider_1' }),
      expect.any(Object),
    );
  });
});

describe('PaymentsService saved payment methods', () => {
  let repo: ReturnType<typeof makeRepo>;
  let orderServiceClient: ReturnType<typeof makeOrderServiceClient>;
  let stripe: ReturnType<typeof makeStripe>;
  let paymentVaultProvider: ReturnType<typeof makePaymentVaultProvider>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    orderServiceClient = makeOrderServiceClient();
    stripe = makeStripe();
    paymentVaultProvider = makePaymentVaultProvider();
    service = createService({
      logger: makeLogger(),
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: makeConfig('sk_test_mock'),
      db: makeDb(),
    });
  });

  it('should register a saved payment method successfully in mock mode', async () => {
    const paymentCustomer = makePaymentCustomer({
      userId: 'user-uuid-1',
      providerCustomerId: 'cus_mock_user',
    });
    const saved = makeSavedPaymentMethod({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      userId: 'user-uuid-1',
      paymentCustomerId: paymentCustomer.id,
      providerPaymentMethodId: 'pm_saved_new',
    });
    const savedDefault = { ...saved, isDefault: true };

    repo.findSavedPaymentMethodByProviderId.mockResolvedValue(null);
    repo.findPaymentCustomerByUserId.mockResolvedValue(null);
    paymentVaultProvider.ensureCustomer.mockResolvedValue({
      provider: 'stripe',
      providerCustomerId: 'cus_mock_user',
    });
    repo.createPaymentCustomer.mockResolvedValue(paymentCustomer);
    paymentVaultProvider.attachPaymentMethod.mockResolvedValue({
      providerPaymentMethodId: 'pm_saved_new',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2099,
      fingerprint: 'fp_mock_4242',
    });
    repo.createSavedPaymentMethod.mockResolvedValue(saved);
    repo.setDefaultSavedPaymentMethod.mockResolvedValue(savedDefault);

    const result = await service.registerSavedPaymentMethod(
      'user-uuid-1',
      {
        providerPaymentMethodId: 'pm_saved_new',
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      },
      {
        source: 'settings-ui',
        ipAddress: '10.0.0.10',
        userAgent: 'Mozilla/5.0',
      },
    );

    expect(paymentVaultProvider.ensureCustomer).toHaveBeenCalledWith('user-uuid-1');
    expect(paymentVaultProvider.attachPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCustomerId: 'cus_mock_user',
        providerPaymentMethodId: 'pm_saved_new',
      }),
    );
    expect(repo.setDefaultSavedPaymentMethod).toHaveBeenCalledWith(
      'user-uuid-1',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(result.isDefault).toBe(true);
  });

  it('should reject registration without explicit consent', async () => {
    await expect(
      service.registerSavedPaymentMethod(
        'user-uuid-1',
        {
          providerPaymentMethodId: 'pm_saved_new',
          setAsDefault: false,
          consentAccepted: false,
          consentVersion: 'settings-card-save-v1',
        },
        {
          source: 'settings-ui',
          ipAddress: '10.0.0.10',
          userAgent: 'Mozilla/5.0',
        },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should set default saved payment method and keep a single default selection', async () => {
    const method = makeSavedPaymentMethod({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      userId: 'user-uuid-1',
      isDefault: false,
    });

    repo.findSavedPaymentMethodById.mockResolvedValue(method);
    repo.setDefaultSavedPaymentMethod.mockResolvedValue({ ...method, isDefault: true });

    const result = await service.setDefaultSavedPaymentMethod(
      'user-uuid-1',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );

    expect(repo.setDefaultSavedPaymentMethod).toHaveBeenCalledWith(
      'user-uuid-1',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    expect(result.isDefault).toBe(true);
  });

  it('should soft-delete saved payment method after provider detach', async () => {
    const method = makeSavedPaymentMethod({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      userId: 'user-uuid-1',
      providerPaymentMethodId: 'pm_saved_delete',
      deletedAt: null,
    });

    repo.findSavedPaymentMethodById.mockResolvedValue(method);
    paymentVaultProvider.detachPaymentMethod.mockResolvedValue(undefined);
    repo.softDeleteSavedPaymentMethod.mockResolvedValue({ ...method, deletedAt: new Date() });

    await service.deleteSavedPaymentMethod('user-uuid-1', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    expect(paymentVaultProvider.detachPaymentMethod).toHaveBeenCalledWith('pm_saved_delete');
    expect(repo.softDeleteSavedPaymentMethod).toHaveBeenCalledWith(
      'user-uuid-1',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    );
  });
});

describe('PaymentsService.requestRefund', () => {
  let repo: ReturnType<typeof makeRepo>;
  let stripe: ReturnType<typeof makeStripe>;
  let paymentVaultProvider: ReturnType<typeof makePaymentVaultProvider>;
  let logger: ReturnType<typeof makeLogger>;
  let config: ReturnType<typeof makeConfig>;
  let db: ReturnType<typeof makeDb>;
  let orderServiceClient: ReturnType<typeof makeOrderServiceClient>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    stripe = makeStripe();
    paymentVaultProvider = makePaymentVaultProvider();
    logger = makeLogger();
    config = makeConfig();
    db = makeDb();
    orderServiceClient = makeOrderServiceClient();

    service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config,
      db,
    });
  });

  it('creates a refund and marks payment as refunded', async () => {
    const payment = makePayment({
      id: 'pay-ref-1',
      orderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      status: PAYMENT_STATUS.COMPLETED,
      amount: 3700,
    });
    const updatedPayment = { ...payment, status: PAYMENT_STATUS.REFUNDED };
    orderServiceClient.getOrderSnapshot.mockResolvedValue(
      makeOrderSnapshot({
        orderId: payment.orderId,
        userId: payment.userId,
        status: 'complete',
        startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      }),
    );
    repo.findByOrderId.mockResolvedValue(payment);
    repo.findActiveRefundByOrderId.mockResolvedValue(null);
    repo.createRefund.mockResolvedValue({
      id: 'ref-1',
      paymentId: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      reason: 'Cannot attend',
      status: 'requested',
      stripeRefundId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    repo.updateStatus.mockResolvedValue(updatedPayment);

    const result = await service.requestRefund({
      orderId: payment.orderId,
      reason: 'Cannot attend',
      userId: payment.userId,
    });

    expect(repo.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: payment.id,
        orderId: payment.orderId,
        amount: payment.amount,
        status: 'requested',
      }),
    );
    expect(repo.updateStatus).toHaveBeenCalledWith(payment.id, PAYMENT_STATUS.REFUNDED);
    expect(result.refundId).toBe('ref-1');
    expect(result.payment.status).toBe(PAYMENT_STATUS.REFUNDED);
  });

  it('rejects refund when order is not complete', async () => {
    orderServiceClient.getOrderSnapshot.mockResolvedValue(
      makeOrderSnapshot({
        status: 'created',
        startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      }),
    );

    await expect(
      service.requestRefund({
        orderId: '11111111-1111-4111-8111-111111111111',
        reason: 'Cannot attend',
        userId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('PaymentsService.findById', () => {
  let repo: ReturnType<typeof makeRepo>;
  let orderServiceClient: ReturnType<typeof makeOrderServiceClient>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    orderServiceClient = makeOrderServiceClient();
    service = createService({
      logger: makeLogger(),
      repo,
      orderServiceClient,
      stripe: makeStripe(),
      paymentVaultProvider: makePaymentVaultProvider(),
      config: makeConfig(),
      db: makeDb(),
    });
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
  let orderServiceClient: ReturnType<typeof makeOrderServiceClient>;
  let stripe: ReturnType<typeof makeStripe>;
  let paymentVaultProvider: ReturnType<typeof makePaymentVaultProvider>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    repo = makeRepo();
    orderServiceClient = makeOrderServiceClient();
    stripe = makeStripe();
    paymentVaultProvider = makePaymentVaultProvider();
    logger = makeLogger();
  });

  it('should ignore orders.order.created in real mode until charge is requested', async () => {
    const realDb = makeDb();
    const service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: makeConfig('sk_test_live'),
      db: realDb,
    });
    repo.findByOrderId.mockResolvedValue(null);

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    expect(realDb.transaction).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.order_created.ignored',
        orderId: 'order-1',
        userId: 'user-1',
        mode: 'real',
        reason: 'awaiting_explicit_charge',
      }),
      'Payment audit event',
    );
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

    const service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: makeConfig('test_mock'),
      db: mockDb,
    });
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

    const service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: makeConfig('sk_test_mock'),
      db: mockDb,
    });
    repo.findByOrderId.mockResolvedValue(null);

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    // Should have used mock path (transaction called) and NOT called Stripe
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('should skip processing when orderId already has a payment (idempotent)', async () => {
    const mockDb = makeDb();
    const service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: makeConfig('test_mock'),
      db: mockDb,
    });
    repo.findByOrderId.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.COMPLETED }));

    await service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 2000 });

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('should re-throw on repository failure so the consumer can retry', async () => {
    const mockDb = makeDb();
    mockDb.transaction.mockRejectedValue(new Error('DB connection lost'));

    const service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: makeConfig('test_mock'),
      db: mockDb,
    });
    repo.findByOrderId.mockResolvedValue(null);

    await expect(
      service.processOrderCreatedEvent({ orderId: 'order-1', userId: 'user-1', amount: 1000 }),
    ).rejects.toThrow('DB connection lost');
  });
});

describe('PaymentsService Stripe webhook idempotency', () => {
  let repo: ReturnType<typeof makeRepo>;
  let orderServiceClient: ReturnType<typeof makeOrderServiceClient>;
  let stripe: ReturnType<typeof makeStripe>;
  let paymentVaultProvider: ReturnType<typeof makePaymentVaultProvider>;
  let db: ReturnType<typeof makeDb>;
  let logger: ReturnType<typeof makeLogger>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    orderServiceClient = makeOrderServiceClient();
    stripe = makeStripe();
    paymentVaultProvider = makePaymentVaultProvider();
    db = makeDb();
    logger = makeLogger();
    service = createService({
      logger,
      repo,
      orderServiceClient,
      stripe,
      paymentVaultProvider,
      config: makeConfig(),
      db,
    });
  });

  it('should audit an applied succeeded webhook transition', async () => {
    repo.findById.mockResolvedValue(
      makePayment({ status: PAYMENT_STATUS.PENDING, stripePaymentIntentId: 'pi_done' }),
    );

    await service.completeStripePayment('pay-uuid-1', 'pi_done');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.webhook.transition_applied',
        transition: 'completed',
        paymentId: 'pay-uuid-1',
        stripeIntentId: 'pi_done',
      }),
      'Payment audit event',
    );
  });

  it('should audit an applied failed webhook transition', async () => {
    repo.findById.mockResolvedValue(
      makePayment({ status: PAYMENT_STATUS.PENDING, stripePaymentIntentId: 'pi_failed' }),
    );

    await service.failStripePayment('pay-uuid-1', 'Card declined', 'pi_failed');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.webhook.transition_applied',
        transition: 'failed',
        paymentId: 'pay-uuid-1',
        stripeIntentId: 'pi_failed',
      }),
      'Payment audit event',
    );
  });

  it('should ignore a succeeded webhook when the state changed concurrently before the update', async () => {
    repo.findById
      .mockResolvedValueOnce(
        makePayment({ status: PAYMENT_STATUS.PENDING, stripePaymentIntentId: 'pi_done' }),
      )
      .mockResolvedValueOnce(makePayment({ status: PAYMENT_STATUS.COMPLETED }));
    db._tx.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    });

    await service.completeStripePayment('pay-uuid-1', 'pi_done');

    expect(db._tx.insert).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.webhook.transition_ignored',
        transition: 'completed',
        paymentId: 'pay-uuid-1',
        reason: 'state_changed_concurrently',
      }),
      'Payment audit event',
    );
  });

  it('should ignore a failed webhook when the state changed concurrently before the update', async () => {
    repo.findById
      .mockResolvedValueOnce(
        makePayment({ status: PAYMENT_STATUS.PENDING, stripePaymentIntentId: 'pi_failed' }),
      )
      .mockResolvedValueOnce(makePayment({ status: PAYMENT_STATUS.COMPLETED }));
    db._tx.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    });

    await service.failStripePayment('pay-uuid-1', 'Card declined', 'pi_failed');

    expect(db._tx.insert).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.webhook.transition_ignored',
        transition: 'failed',
        paymentId: 'pay-uuid-1',
        reason: 'state_changed_concurrently',
      }),
      'Payment audit event',
    );
  });

  it('should ignore duplicate succeeded webhooks for completed payments', async () => {
    repo.findById.mockResolvedValue(
      makePayment({ status: PAYMENT_STATUS.COMPLETED, stripePaymentIntentId: 'pi_done' }),
    );

    await service.completeStripePayment('pay-uuid-1', 'pi_done');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('should ignore late succeeded webhooks for failed payments', async () => {
    repo.findById.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.FAILED }));

    await service.completeStripePayment('pay-uuid-1', 'pi_late');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('should ignore duplicate failed webhooks for failed payments', async () => {
    repo.findById.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.FAILED }));

    await service.failStripePayment('pay-uuid-1', 'Card declined');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('should ignore late failed webhooks for completed payments', async () => {
    repo.findById.mockResolvedValue(makePayment({ status: PAYMENT_STATUS.COMPLETED }));

    await service.failStripePayment('pay-uuid-1', 'Late failure');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('should ignore succeeded webhooks when the Stripe intent does not match the stored payment', async () => {
    repo.findById.mockResolvedValue(
      makePayment({ status: PAYMENT_STATUS.PENDING, stripePaymentIntentId: 'pi_expected' }),
    );

    await service.completeStripePayment('pay-uuid-1', 'pi_other');

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('should ignore failed webhooks when the Stripe intent does not match the stored payment', async () => {
    repo.findById.mockResolvedValue(
      makePayment({ status: PAYMENT_STATUS.PENDING, stripePaymentIntentId: 'pi_expected' }),
    );

    await service.failStripePayment('pay-uuid-1', 'Card declined', 'pi_other');

    expect(db.transaction).not.toHaveBeenCalled();
  });
});
