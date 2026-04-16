import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Inject,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'crypto';
import { RegisterSavedPaymentMethodDto } from './payments.dto';
import { PAYMENT_VAULT_PROVIDER, type PaymentVaultProvider } from './payment-vault.provider';
import { PaymentsRepository } from './payments.repository';
import { OrderServiceClient } from './order-service.client';
import { STRIPE_CLIENT } from './stripe.constants';
import {
  type Payment,
  type SavedPaymentMethod,
  PAYMENT_STATUS,
  outbox,
  payments,
} from '../../database/schema';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { captureTraceHeaders } from '../../kafka/trace-context';

interface RegisterSavedPaymentMethodContext {
  source: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface ChargePaymentDto {
  orderId: string;
  userId: string;
  /** Stripe token or paymentMethodId from the client. */
  token?: string;
  savedPaymentMethodId?: string;
  /** X-User-Id-Sig from Kong (validates the user ID). */
  userIdSig?: string;
}

const PAYABLE_ORDER_STATUSES = new Set(['created', 'awaiting_payment']);
const TERMINAL_PAYMENT_STATUSES = new Set<string>([
  PAYMENT_STATUS.COMPLETED,
  PAYMENT_STATUS.FAILED,
]);
const FAILED_INTENT_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  'canceled',
  'requires_payment_method',
]);
const MOCK_DECLINED_TOKEN = 'pm_mock_declined';
const MOCK_DECLINED_REASON = 'Mock payment declined';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectPinoLogger(PaymentsService.name)
    private readonly logger: PinoLogger,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly orderServiceClient: OrderServiceClient,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    @Inject(PAYMENT_VAULT_PROVIDER)
    private readonly paymentVaultProvider: PaymentVaultProvider,
    private readonly config: ConfigService,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
  ) {}

  /**
   * Returns true when STRIPE_SECRET_KEY contains 'test_mock'.
   *
   * Handles both 'test_mock' (bare) and 'sk_test_mock' (with prefix) — fixes
   * audit finding C-06 where the bare equality check missed the sk_ prefix variant
   * present in local dev docker-compose.
   */
  private get isMockMode(): boolean {
    return this.config.get<string>('STRIPE_SECRET_KEY')?.includes('test_mock') ?? false;
  }

  private auditInfo(event: string, context: Record<string, unknown>): void {
    this.logger.info({ event, ...context }, 'Payment audit event');
  }

  private auditWarn(event: string, context: Record<string, unknown>): void {
    this.logger.warn({ event, ...context }, 'Payment audit event');
  }

  private auditError(event: string, context: Record<string, unknown>): void {
    this.logger.error({ event, ...context }, 'Payment audit event');
  }

  private errorAuditDetails(err: unknown): Record<string, unknown> {
    if (err instanceof Stripe.errors.StripeError) {
      return {
        errorName: err.name,
        errorType: err.type,
        errorCode: err.code,
      };
    }

    if (err instanceof Error) {
      return {
        errorName: err.name,
        errorMessage: err.message,
      };
    }

    return { errorMessage: String(err) };
  }

  private isMockDeclinedToken(token: string): boolean {
    return token === MOCK_DECLINED_TOKEN;
  }

  private normalizeConsentSource(source: string): string {
    const trimmed = source.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 64) : 'unknown';
  }

  private hashIpAddress(ipAddress?: string): string | null {
    if (!ipAddress) {
      return null;
    }

    const trimmed = ipAddress.trim();
    if (!trimmed) {
      return null;
    }

    return createHash('sha256').update(trimmed).digest('hex');
  }

  private isDefaultConflictError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { code?: string; constraint?: string };
    return (
      candidate.code === '23505' &&
      candidate.constraint === 'uniq_saved_payment_methods_single_default'
    );
  }

  private async setDefaultWithConflictHandling(
    userId: string,
    id: string,
  ): Promise<SavedPaymentMethod | null> {
    try {
      return await this.paymentsRepo.setDefaultSavedPaymentMethod(userId, id);
    } catch (error) {
      if (this.isDefaultConflictError(error)) {
        throw new ConflictException({
          error: {
            code: 'DEFAULT_PAYMENT_METHOD_CONFLICT',
            message: 'Another default payment method update was processed concurrently. Retry.',
          },
        });
      }

      throw error;
    }
  }

  private buildMockStripeIntentId(
    orderId: string,
    outcome: 'succeeded' | 'failed' = 'succeeded',
  ): string {
    return outcome === 'failed' ? `mock_pi_failed_${orderId}` : `mock_pi_${orderId}`;
  }

  private async resolveMockChargeOutcome(
    order: {
      orderId: string;
      userId: string;
      amount: number;
      currency: string;
    },
    token: string,
  ): Promise<Payment> {
    if (this.isMockDeclinedToken(token)) {
      return this.failMockCharge(
        order.orderId,
        order.userId,
        order.amount,
        order.currency,
        MOCK_DECLINED_REASON,
      );
    }

    return this.completeMockPayment(order.orderId, order.userId, order.amount, order.currency);
  }

  private async resolveChargeToken(dto: ChargePaymentDto): Promise<string> {
    if (dto.token) {
      return dto.token;
    }

    if (!dto.savedPaymentMethodId) {
      throw new BadRequestException({
        error: {
          code: 'MISSING_PAYMENT_SOURCE',
          message: 'Either token or savedPaymentMethodId is required',
        },
      });
    }

    const savedPaymentMethod = await this.paymentsRepo.findSavedPaymentMethodById(
      dto.savedPaymentMethodId,
    );
    if (
      !savedPaymentMethod ||
      savedPaymentMethod.userId !== dto.userId ||
      savedPaymentMethod.deletedAt
    ) {
      throw new NotFoundException({
        error: {
          code: 'PAYMENT_METHOD_NOT_FOUND',
          message: 'Saved payment method not found',
        },
      });
    }

    return savedPaymentMethod.providerPaymentMethodId;
  }

  /**
   * Create a new payment for an order.
   * Idempotent: if a payment for the given orderId already exists, returns it.
   */
  async charge(dto: ChargePaymentDto): Promise<Payment> {
    this.auditInfo('payment.charge.attempted', {
      orderId: dto.orderId,
      userId: dto.userId,
    });

    // Idempotency check — Kafka may redeliver the same event
    const existing = await this.paymentsRepo.findByOrderId(dto.orderId);
    if (existing) {
      if (existing.userId !== dto.userId) {
        this.auditWarn('payment.charge.rejected', {
          orderId: dto.orderId,
          paymentId: existing.id,
          userId: dto.userId,
          reason: 'user_mismatch',
        });
        throw new NotFoundException({
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
        });
      }

      if (existing.status === PAYMENT_STATUS.PENDING) {
        const token = await this.resolveChargeToken(dto);
        this.auditInfo('payment.charge.resumed', {
          orderId: dto.orderId,
          paymentId: existing.id,
          stripeIntentId: existing.stripePaymentIntentId,
        });
        this.logger.info(
          { orderId: dto.orderId, paymentId: existing.id },
          'Pending payment already exists — attempting to continue charge',
        );
        return this.confirmPendingPayment(existing, token);
      }

      this.auditInfo('payment.charge.returned_existing', {
        orderId: dto.orderId,
        paymentId: existing.id,
        status: existing.status,
      });

      this.logger.info(
        { orderId: dto.orderId, paymentId: existing.id },
        'Payment already exists — skipping duplicate',
      );
      return existing;
    }

    const order = await this.orderServiceClient.getOrderSnapshot(
      dto.orderId,
      dto.userId,
      dto.userIdSig,
    );
    if (!PAYABLE_ORDER_STATUSES.has(order.status)) {
      this.auditWarn('payment.charge.rejected', {
        orderId: order.orderId,
        userId: order.userId,
        orderStatus: order.status,
        reason: 'order_not_payable',
      });
      throw new ConflictException({
        error: {
          code: 'ORDER_NOT_PAYABLE',
          message: 'Order is not payable in its current state',
        },
      });
    }

    const token = await this.resolveChargeToken(dto);

    if (this.isMockMode) {
      // Mock path: deterministically complete or fail based on the supplied test token.
      return this.resolveMockChargeOutcome(order, token);
    }

    // Real Stripe path: create PENDING first, then attempt charge
    const payment = await this.paymentsRepo.create({
      orderId: order.orderId,
      userId: order.userId,
      amount: order.amount,
      currency: order.currency,
      status: PAYMENT_STATUS.PENDING,
    });

    this.logger.info(
      { paymentId: payment.id, orderId: order.orderId },
      'Payment created (pending)',
    );
    this.auditInfo('payment.charge.record_created', {
      orderId: order.orderId,
      paymentId: payment.id,
      userId: order.userId,
      amount: order.amount,
      currency: order.currency,
      status: payment.status,
    });

    // Publish payment.initiated event to notify order-service to transition to AWAITING_PAYMENT
    await this.db.transaction(async (tx) => {
      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.initiated', order.orderId, {
          orderId: order.orderId,
          paymentId: payment.id,
          userId: order.userId,
          amount: order.amount,
          currency: order.currency,
        }),
      );
    });

    try {
      this.auditInfo('payment.charge.stripe_requested', {
        orderId: order.orderId,
        paymentId: payment.id,
        attemptKind: 'create_payment_intent',
      });

      const intent = await this.stripe.paymentIntents.create(
        {
          amount: order.amount,
          currency: order.currency,
          payment_method: token,
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: {
            orderId: order.orderId,
            userId: order.userId,
            paymentId: payment.id,
          },
        },
        { idempotencyKey: order.orderId }, // prevents double-charge on retry (fixes R-12)
      );

      return this.resolveStripeIntentOutcome(payment, intent);
    } catch (err) {
      // Mark payment as failed — never leave it in pending state
      await this.paymentsRepo.updateStatus(payment.id, PAYMENT_STATUS.FAILED);

      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.auditError('payment.charge.failed', {
        orderId: order.orderId,
        paymentId: payment.id,
        userId: order.userId,
        ...this.errorAuditDetails(err),
      });
      this.logger.error({ paymentId: payment.id, err: msg }, 'Payment failed');

      throw new InternalServerErrorException({
        error: { code: 'PAYMENT_FAILED', message: 'Payment processing failed' },
      });
    }
  }

  async registerSavedPaymentMethod(
    userId: string,
    dto: RegisterSavedPaymentMethodDto,
    context: RegisterSavedPaymentMethodContext,
  ): Promise<SavedPaymentMethod> {
    if (!dto.consentAccepted) {
      throw new BadRequestException({
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'Explicit card-on-file consent is required',
        },
      });
    }

    const consentVersion = dto.consentVersion.trim();
    if (!consentVersion) {
      throw new BadRequestException({
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'Consent version is required',
        },
      });
    }

    this.auditInfo('payment.method.register.attempted', {
      userId,
      providerPaymentMethodId: dto.providerPaymentMethodId,
      consentVersion,
      consentSource: this.normalizeConsentSource(context.source),
    });

    const existingByProvider = await this.paymentsRepo.findSavedPaymentMethodByProviderId(
      dto.providerPaymentMethodId,
    );
    if (existingByProvider && existingByProvider.deletedAt) {
      throw new ConflictException({
        error: {
          code: 'PAYMENT_METHOD_EXISTS',
          message: 'Saved payment method already exists',
        },
      });
    }

    if (existingByProvider && existingByProvider.userId !== userId) {
      throw new ConflictException({
        error: {
          code: 'PAYMENT_METHOD_EXISTS',
          message: 'Saved payment method already exists',
        },
      });
    }

    if (existingByProvider) {
      if (dto.setAsDefault) {
        const updated = await this.setDefaultWithConflictHandling(userId, existingByProvider.id);
        if (updated) {
          return updated;
        }
      }
      return existingByProvider;
    }

    let paymentCustomer = await this.paymentsRepo.findPaymentCustomerByUserId(userId);
    if (!paymentCustomer) {
      const customer = await this.paymentVaultProvider.ensureCustomer(userId);
      paymentCustomer = await this.paymentsRepo.createPaymentCustomer({
        userId,
        provider: customer.provider,
        providerCustomerId: customer.providerCustomerId,
      });
    }

    const attached = await this.paymentVaultProvider.attachPaymentMethod({
      providerCustomerId: paymentCustomer.providerCustomerId,
      providerPaymentMethodId: dto.providerPaymentMethodId,
    });

    const savedPaymentMethod = await this.paymentsRepo.createSavedPaymentMethod({
      userId,
      paymentCustomerId: paymentCustomer.id,
      provider: paymentCustomer.provider,
      providerPaymentMethodId: attached.providerPaymentMethodId,
      brand: attached.brand,
      last4: attached.last4,
      expMonth: attached.expMonth,
      expYear: attached.expYear,
      fingerprint: attached.fingerprint ?? null,
      isDefault: false,
      consentGivenAt: new Date(),
      consentVersion,
      consentSource: this.normalizeConsentSource(context.source),
      consentIpHash: this.hashIpAddress(context.ipAddress),
      consentUserAgent: context.userAgent?.slice(0, 512) ?? null,
    });

    if (dto.setAsDefault) {
      const updated = await this.setDefaultWithConflictHandling(userId, savedPaymentMethod.id);
      if (updated) {
        return updated;
      }
    }

    this.auditInfo('payment.method.register.completed', {
      userId,
      savedPaymentMethodId: savedPaymentMethod.id,
    });

    return savedPaymentMethod;
  }

  async listSavedPaymentMethods(userId: string): Promise<SavedPaymentMethod[]> {
    return this.paymentsRepo.listSavedPaymentMethodsByUserId(userId);
  }

  async setDefaultSavedPaymentMethod(userId: string, id: string): Promise<SavedPaymentMethod> {
    const savedPaymentMethod = await this.paymentsRepo.findSavedPaymentMethodById(id);
    if (
      !savedPaymentMethod ||
      savedPaymentMethod.userId !== userId ||
      savedPaymentMethod.deletedAt
    ) {
      throw new NotFoundException({
        error: {
          code: 'PAYMENT_METHOD_NOT_FOUND',
          message: 'Saved payment method not found',
        },
      });
    }

    const updated = await this.setDefaultWithConflictHandling(userId, id);
    if (!updated) {
      throw new NotFoundException({
        error: {
          code: 'PAYMENT_METHOD_NOT_FOUND',
          message: 'Saved payment method not found',
        },
      });
    }

    this.auditInfo('payment.method.default.updated', {
      userId,
      savedPaymentMethodId: id,
    });

    return updated;
  }

  async deleteSavedPaymentMethod(userId: string, id: string): Promise<void> {
    const savedPaymentMethod = await this.paymentsRepo.findSavedPaymentMethodById(id);
    if (
      !savedPaymentMethod ||
      savedPaymentMethod.userId !== userId ||
      savedPaymentMethod.deletedAt
    ) {
      throw new NotFoundException({
        error: {
          code: 'PAYMENT_METHOD_NOT_FOUND',
          message: 'Saved payment method not found',
        },
      });
    }

    await this.paymentVaultProvider.detachPaymentMethod(savedPaymentMethod.providerPaymentMethodId);
    await this.paymentsRepo.softDeleteSavedPaymentMethod(userId, id);

    this.auditInfo('payment.method.deleted', {
      userId,
      savedPaymentMethodId: id,
    });
  }

  async findById(id: string): Promise<Payment> {
    const payment = await this.paymentsRepo.findById(id);
    if (!payment) {
      throw new NotFoundException({
        error: { code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' },
      });
    }
    return payment;
  }

  /**
   * Process an order event received from Kafka.
   *
   * In mock mode: immediately marks the payment as COMPLETED and writes the
   * payments.payment.captured event to the outbox in a single DB transaction.
   *
   * In real mode: records the order-created signal for observability only.
   * Payment creation and Stripe initiation happen exclusively via POST /api/payments.
   */
  async processOrderCreatedEvent(event: {
    orderId: string;
    userId: string;
    amount: number;
    currency?: string;
  }): Promise<void> {
    this.logger.info(
      { orderId: event.orderId, mock: this.isMockMode },
      'Processing order.created event',
    );

    try {
      // Idempotency: if we already processed this order, skip silently
      const existing = await this.paymentsRepo.findByOrderId(event.orderId);
      if (existing) {
        this.auditInfo('payment.order_created.ignored', {
          orderId: event.orderId,
          paymentId: existing.id,
          mode: this.isMockMode ? 'mock' : 'real',
          reason: 'payment_exists',
          status: existing.status,
        });
        this.logger.info({ orderId: event.orderId }, 'Order already processed — skipping');
        return;
      }

      if (!this.isMockMode) {
        this.auditInfo('payment.order_created.ignored', {
          orderId: event.orderId,
          userId: event.userId,
          mode: 'real',
          reason: 'awaiting_explicit_charge',
        });
        this.logger.info(
          { orderId: event.orderId },
          'Observed order.created in real mode — awaiting explicit payment initiation',
        );
        return;
      }

      this.auditInfo('payment.order_created.mock_autocomplete', {
        orderId: event.orderId,
        userId: event.userId,
        amount: event.amount,
        currency: event.currency ?? 'usd',
      });

      // Mock path: create payment as COMPLETED and write outbox entry atomically.
      // This allows the full order flow to complete in local dev and test environments.
      await this.completeMockPayment(
        event.orderId,
        event.userId,
        event.amount,
        event.currency ?? 'usd',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.auditError('payment.order_created.failed', {
        orderId: event.orderId,
        mode: this.isMockMode ? 'mock' : 'real',
        ...this.errorAuditDetails(err),
      });
      this.logger.error({ orderId: event.orderId, err: msg }, 'Failed to process order event');
      // Re-throw so the Kafka consumer can route to DLQ
      throw err;
    }
  }

  /**
   * Verify a Stripe webhook payload and return the parsed event.
   * Throws if the signature is invalid or STRIPE_WEBHOOK_SECRET is not configured.
   */
  constructWebhookEvent(payload: Buffer | string, sig: string): Stripe.Event {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    return this.stripe.webhooks.constructEvent(payload, sig, secret);
  }

  /**
   * Route a verified Stripe event to the appropriate handler.
   * Unknown event types are logged and ignored (Stripe sends many event types).
   */
  async handleStripeEvent(event: Stripe.Event): Promise<void> {
    const stripeObject = event.data.object as Stripe.PaymentIntent | undefined;
    this.auditInfo('payment.webhook.received', {
      webhookType: event.type,
      paymentId: stripeObject?.metadata?.paymentId,
      stripeIntentId: stripeObject?.id,
    });
    this.logger.info({ type: event.type }, 'Stripe webhook received');
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const paymentId = pi.metadata?.paymentId;
        if (paymentId) {
          await this.completeStripePayment(paymentId, pi.id);
        } else {
          this.auditWarn('payment.webhook.ignored', {
            webhookType: event.type,
            stripeIntentId: pi.id,
            reason: 'missing_payment_id',
          });
          this.logger.warn(
            { intentId: pi.id },
            'payment_intent.succeeded: missing paymentId in metadata',
          );
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const pf = event.data.object;
        const paymentId = pf.metadata?.paymentId;
        const reason = pf.last_payment_error?.message ?? 'Payment failed';
        if (paymentId) {
          await this.failStripePayment(paymentId, reason, pf.id);
        } else {
          this.auditWarn('payment.webhook.ignored', {
            webhookType: event.type,
            stripeIntentId: pf.id,
            reason: 'missing_payment_id',
          });
          this.logger.warn(
            { intentId: pf.id },
            'payment_intent.payment_failed: missing paymentId in metadata',
          );
        }
        break;
      }
      default:
        this.auditInfo('payment.webhook.ignored', {
          webhookType: event.type,
          reason: 'unhandled_type',
        });
        this.logger.info({ type: event.type }, 'Stripe event ignored (not handled)');
    }
  }

  /**
   * Mark a payment FAILED and write a payments.payment.failed outbox event.
   * This causes order-service to cancel the order and release any seat holds.
   */
  async failStripePayment(
    paymentId: string,
    reason: string,
    stripeIntentId?: string,
  ): Promise<void> {
    const payment = await this.paymentsRepo.findById(paymentId);
    if (!payment) {
      this.auditWarn('payment.webhook.transition_ignored', {
        transition: 'failed',
        paymentId,
        stripeIntentId,
        reason: 'payment_not_found',
      });
      this.logger.warn({ paymentId }, 'failStripePayment: payment not found — skipping');
      return;
    }

    if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      this.auditInfo('payment.webhook.transition_ignored', {
        transition: 'failed',
        orderId: payment.orderId,
        paymentId,
        stripeIntentId,
        reason: 'already_terminal',
        currentStatus: payment.status,
      });
      this.logger.info(
        { paymentId, currentStatus: payment.status },
        'failStripePayment: payment already terminal — skipping duplicate transition',
      );
      return;
    }

    if (this.hasMismatchedStripeIntentId(payment, stripeIntentId)) {
      this.auditWarn('payment.webhook.transition_ignored', {
        transition: 'failed',
        orderId: payment.orderId,
        paymentId,
        stripeIntentId,
        expectedStripeIntentId: payment.stripePaymentIntentId,
        reason: 'stripe_intent_mismatch',
      });
      this.logger.warn(
        {
          paymentId,
          expectedStripeIntentId: payment.stripePaymentIntentId,
          receivedStripeIntentId: stripeIntentId,
        },
        'failStripePayment: Stripe intent ID mismatch — skipping transition',
      );
      return;
    }

    let transitionApplied = false;

    await this.db.transaction(async (tx) => {
      const [updatedPayment] = await tx
        .update(payments)
        .set({ status: PAYMENT_STATUS.FAILED, updatedAt: new Date() })
        .where(and(eq(payments.id, paymentId), eq(payments.status, PAYMENT_STATUS.PENDING)))
        .returning();

      if (!updatedPayment) {
        return;
      }

      transitionApplied = true;

      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.failed', payment.orderId, {
          orderId: payment.orderId,
          paymentId,
          userId: payment.userId,
          reason,
        }),
      );
    });

    if (!transitionApplied) {
      const currentPayment = await this.paymentsRepo.findById(paymentId);

      this.auditInfo('payment.webhook.transition_ignored', {
        transition: 'failed',
        orderId: payment.orderId,
        paymentId,
        stripeIntentId,
        reason: 'state_changed_concurrently',
        currentStatus: currentPayment?.status,
      });
      this.logger.info(
        { paymentId, currentStatus: currentPayment?.status },
        'failStripePayment: payment state changed concurrently — skipping duplicate transition',
      );
      return;
    }

    this.auditWarn('payment.webhook.transition_applied', {
      transition: 'failed',
      orderId: payment.orderId,
      paymentId,
      stripeIntentId,
    });

    this.logger.warn({ paymentId, reason }, 'Payment marked FAILED — outbox entry written');
  }

  /**
   * Complete a real Stripe payment and publish the outbox event atomically.
   * Called from the Stripe webhook handler once a PaymentIntent is confirmed.
   */
  async completeStripePayment(paymentId: string, stripeIntentId: string): Promise<void> {
    const payment = await this.paymentsRepo.findById(paymentId);
    if (!payment) {
      this.auditWarn('payment.webhook.transition_ignored', {
        transition: 'completed',
        paymentId,
        stripeIntentId,
        reason: 'payment_not_found',
      });
      this.logger.warn({ paymentId }, 'completeStripePayment: payment not found — skipping');
      return;
    }

    if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      this.auditInfo('payment.webhook.transition_ignored', {
        transition: 'completed',
        orderId: payment.orderId,
        paymentId,
        stripeIntentId,
        reason: 'already_terminal',
        currentStatus: payment.status,
      });
      this.logger.info(
        { paymentId, currentStatus: payment.status },
        'completeStripePayment: payment already terminal — skipping duplicate transition',
      );
      return;
    }

    if (this.hasMismatchedStripeIntentId(payment, stripeIntentId)) {
      this.auditWarn('payment.webhook.transition_ignored', {
        transition: 'completed',
        orderId: payment.orderId,
        paymentId,
        stripeIntentId,
        expectedStripeIntentId: payment.stripePaymentIntentId,
        reason: 'stripe_intent_mismatch',
      });
      this.logger.warn(
        {
          paymentId,
          expectedStripeIntentId: payment.stripePaymentIntentId,
          receivedStripeIntentId: stripeIntentId,
        },
        'completeStripePayment: Stripe intent ID mismatch — skipping transition',
      );
      return;
    }

    const completedPayment = await this.completePaymentWithOutbox(
      paymentId,
      payment.orderId,
      payment.userId,
      payment.amount,
      payment.currency,
      stripeIntentId,
    );

    if (!completedPayment) {
      const currentPayment = await this.paymentsRepo.findById(paymentId);
      this.auditInfo('payment.webhook.transition_ignored', {
        transition: 'completed',
        orderId: payment.orderId,
        paymentId,
        stripeIntentId,
        reason: 'state_changed_concurrently',
        currentStatus: currentPayment?.status,
      });
      this.logger.info(
        { paymentId, currentStatus: currentPayment?.status },
        'completeStripePayment: payment state changed concurrently — skipping duplicate transition',
      );
      return;
    }

    this.auditInfo('payment.webhook.transition_applied', {
      transition: 'completed',
      orderId: payment.orderId,
      paymentId,
      stripeIntentId,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Create a mock payment as COMPLETED and write the outbox event atomically.
   * Used in local dev and test environments where Stripe is not available.
   */
  private async completeMockPayment(
    orderId: string,
    userId: string,
    amount: number,
    currency: string,
  ): Promise<Payment> {
    const stripeIntentId = `mock_pi_${orderId}`;

    let payment: Payment | undefined;

    await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(payments)
        .values({
          orderId,
          userId,
          amount,
          currency,
          status: PAYMENT_STATUS.COMPLETED,
          stripePaymentIntentId: stripeIntentId,
        })
        .returning();
      payment = inserted;

      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.captured', orderId, {
          orderId,
          paymentId: inserted.id,
          userId,
          amount,
          currency,
        }),
      );
    });

    this.logger.info(
      { paymentId: payment!.id, orderId },
      'Payment completed (mock) — outbox entry written',
    );
    this.auditInfo('payment.charge.completed', {
      orderId,
      paymentId: payment!.id,
      userId,
      amount,
      currency,
      mode: 'mock',
      stripeIntentId,
    });
    return payment!;
  }

  private async confirmPendingPayment(payment: Payment, token: string): Promise<Payment> {
    if (this.isMockMode) {
      return this.resolvePendingMockChargeOutcome(payment, token);
    }

    try {
      this.auditInfo('payment.charge.stripe_requested', {
        orderId: payment.orderId,
        paymentId: payment.id,
        attemptKind: payment.stripePaymentIntentId
          ? 'confirm_existing_intent'
          : 'create_and_confirm_intent',
      });

      const intent = payment.stripePaymentIntentId
        ? await this.stripe.paymentIntents.confirm(payment.stripePaymentIntentId, {
            payment_method: token,
          })
        : await this.stripe.paymentIntents.create(
            {
              amount: payment.amount,
              currency: payment.currency,
              payment_method: token,
              confirm: true,
              automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
              metadata: {
                orderId: payment.orderId,
                userId: payment.userId,
                paymentId: payment.id,
              },
            },
            { idempotencyKey: payment.orderId },
          );

      return this.resolveStripeIntentOutcome(payment, intent);
    } catch (err) {
      await this.paymentsRepo.updateStatus(payment.id, PAYMENT_STATUS.FAILED);

      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.auditError('payment.charge.failed', {
        orderId: payment.orderId,
        paymentId: payment.id,
        userId: payment.userId,
        ...this.errorAuditDetails(err),
      });
      this.logger.error({ paymentId: payment.id, err: msg }, 'Pending payment confirmation failed');

      throw new InternalServerErrorException({
        error: { code: 'PAYMENT_FAILED', message: 'Payment processing failed' },
      });
    }
  }

  private async resolveStripeIntentOutcome(
    payment: Payment,
    intent: Pick<Stripe.PaymentIntent, 'id' | 'status'>,
  ): Promise<Payment> {
    if (FAILED_INTENT_STATUSES.has(intent.status)) {
      await this.paymentsRepo.updateStatus(payment.id, PAYMENT_STATUS.FAILED, intent.id);
      this.auditWarn('payment.charge.failed', {
        orderId: payment.orderId,
        paymentId: payment.id,
        userId: payment.userId,
        stripeIntentId: intent.id,
        stripeStatus: intent.status,
      });
      this.logger.warn(
        {
          paymentId: payment.id,
          orderId: payment.orderId,
          stripeIntentId: intent.id,
          stripeStatus: intent.status,
        },
        'Stripe PaymentIntent returned a terminal failure status',
      );
      throw new InternalServerErrorException({
        error: { code: 'PAYMENT_FAILED', message: 'Payment processing failed' },
      });
    }

    if (intent.status !== 'succeeded') {
      const pendingPayment = await this.paymentsRepo.updateStatus(
        payment.id,
        PAYMENT_STATUS.PENDING,
        intent.id,
      );
      this.auditInfo('payment.charge.pending', {
        orderId: payment.orderId,
        paymentId: payment.id,
        userId: payment.userId,
        stripeIntentId: intent.id,
        stripeStatus: intent.status,
      });
      this.logger.info(
        {
          paymentId: payment.id,
          orderId: payment.orderId,
          stripeIntentId: intent.id,
          stripeStatus: intent.status,
        },
        'Stripe PaymentIntent created without terminal success; awaiting webhook completion',
      );
      return pendingPayment;
    }

    const completedPayment = await this.completePaymentWithOutbox(
      payment.id,
      payment.orderId,
      payment.userId,
      payment.amount,
      payment.currency,
      intent.id,
    );

    if (!completedPayment) {
      const currentPayment = await this.paymentsRepo.findById(payment.id);
      if (currentPayment) {
        this.auditInfo('payment.charge.returned_existing', {
          orderId: currentPayment.orderId,
          paymentId: currentPayment.id,
          status: currentPayment.status,
        });
        return currentPayment;
      }

      throw new InternalServerErrorException({
        error: { code: 'PAYMENT_FAILED', message: 'Payment processing failed' },
      });
    }

    this.auditInfo('payment.charge.completed', {
      orderId: payment.orderId,
      paymentId: payment.id,
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.currency,
      mode: this.isMockMode ? 'mock' : 'live',
      stripeIntentId: intent.id,
    });
    return completedPayment;
  }

  private async resolvePendingMockChargeOutcome(payment: Payment, token: string): Promise<Payment> {
    if (this.isMockDeclinedToken(token)) {
      return this.failPendingMockCharge(payment, MOCK_DECLINED_REASON);
    }

    const stripeIntentId = this.buildMockStripeIntentId(payment.orderId);
    const completedPayment = await this.completePaymentWithOutbox(
      payment.id,
      payment.orderId,
      payment.userId,
      payment.amount,
      payment.currency,
      stripeIntentId,
    );

    if (!completedPayment) {
      const currentPayment = await this.paymentsRepo.findById(payment.id);
      if (currentPayment) {
        this.auditInfo('payment.charge.returned_existing', {
          orderId: currentPayment.orderId,
          paymentId: currentPayment.id,
          status: currentPayment.status,
        });
        return currentPayment;
      }

      throw new InternalServerErrorException({
        error: { code: 'PAYMENT_FAILED', message: 'Payment processing failed' },
      });
    }

    this.auditInfo('payment.charge.completed', {
      orderId: payment.orderId,
      paymentId: payment.id,
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.currency,
      mode: 'mock',
      stripeIntentId,
    });
    return completedPayment;
  }

  private async failPendingMockCharge(payment: Payment, reason: string): Promise<never> {
    const stripeIntentId = this.buildMockStripeIntentId(payment.orderId, 'failed');
    const failedPayment = await this.failPaymentWithOutbox(
      payment.id,
      payment.orderId,
      payment.userId,
      payment.amount,
      payment.currency,
      reason,
      stripeIntentId,
    );

    if (failedPayment) {
      this.auditWarn('payment.charge.failed', {
        orderId: payment.orderId,
        paymentId: payment.id,
        userId: payment.userId,
        amount: payment.amount,
        currency: payment.currency,
        mode: 'mock',
        stripeIntentId,
        reason,
      });
    }

    throw new InternalServerErrorException({
      error: { code: 'PAYMENT_FAILED', message: reason },
    });
  }

  private async failMockCharge(
    orderId: string,
    userId: string,
    amount: number,
    currency: string,
    reason: string,
  ): Promise<never> {
    let payment: Payment | undefined;
    const stripeIntentId = this.buildMockStripeIntentId(orderId, 'failed');

    await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(payments)
        .values({
          orderId,
          userId,
          amount,
          currency,
          status: PAYMENT_STATUS.FAILED,
          stripePaymentIntentId: stripeIntentId,
        })
        .returning();
      payment = inserted;

      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.failed', orderId, {
          orderId,
          paymentId: inserted.id,
          userId,
          reason,
        }),
      );
    });

    this.auditWarn('payment.charge.failed', {
      orderId,
      paymentId: payment?.id,
      userId,
      amount,
      currency,
      mode: 'mock',
      stripeIntentId,
      reason,
    });
    this.logger.warn(
      { orderId, paymentId: payment?.id, reason },
      'Mock payment declined — outbox entry written',
    );

    throw new InternalServerErrorException({
      error: { code: 'PAYMENT_FAILED', message: reason },
    });
  }

  /**
   * Mark a payment as COMPLETED and write the outbox event in a single DB transaction.
   */
  private async completePaymentWithOutbox(
    paymentId: string,
    orderId: string,
    userId: string,
    amount: number,
    currency: string,
    stripeIntentId: string,
  ): Promise<Payment | null> {
    let updated: Payment | undefined;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(payments)
        .set({
          status: PAYMENT_STATUS.COMPLETED,
          stripePaymentIntentId: stripeIntentId,
          updatedAt: new Date(),
        })
        .where(and(eq(payments.id, paymentId), eq(payments.status, PAYMENT_STATUS.PENDING)))
        .returning();

      if (!row) {
        return;
      }

      updated = row;

      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.captured', orderId, {
          orderId,
          paymentId,
          userId,
          amount,
          currency,
        }),
      );
    });

    if (!updated) {
      return null;
    }

    this.logger.info({ paymentId, stripeIntentId }, 'Payment completed — outbox entry written');
    return updated;
  }

  private async failPaymentWithOutbox(
    paymentId: string,
    orderId: string,
    userId: string,
    amount: number,
    currency: string,
    reason: string,
    stripeIntentId: string,
  ): Promise<Payment | null> {
    let updated: Payment | undefined;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(payments)
        .set({
          status: PAYMENT_STATUS.FAILED,
          stripePaymentIntentId: stripeIntentId,
          updatedAt: new Date(),
        })
        .where(and(eq(payments.id, paymentId), eq(payments.status, PAYMENT_STATUS.PENDING)))
        .returning();

      if (!row) {
        return;
      }

      updated = row;

      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.failed', orderId, {
          orderId,
          paymentId,
          userId,
          reason,
          amount,
          currency,
        }),
      );
    });

    if (!updated) {
      return null;
    }

    this.logger.warn({ paymentId, stripeIntentId }, 'Payment failed — outbox entry written');
    return updated;
  }

  private buildOutboxRow(topic: string, partitionKey: string, data: Record<string, unknown>) {
    return {
      topic,
      partitionKey,
      traceHeaders: captureTraceHeaders(),
      payload: {
        specversion: '1.0',
        type: topic,
        source: 'payment-service',
        id: randomUUID(),
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        data,
      },
    };
  }

  private hasMismatchedStripeIntentId(
    payment: Pick<Payment, 'stripePaymentIntentId'>,
    stripeIntentId: string | undefined,
  ): boolean {
    if (!payment.stripePaymentIntentId || !stripeIntentId) {
      return false;
    }
    return payment.stripePaymentIntentId !== stripeIntentId;
  }
}
