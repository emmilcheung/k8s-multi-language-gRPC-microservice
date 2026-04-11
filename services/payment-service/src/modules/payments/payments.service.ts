import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Inject,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { PaymentsRepository } from './payments.repository';
import { OrderServiceClient } from './order-service.client';
import { STRIPE_CLIENT } from './stripe.constants';
import { type Payment, PAYMENT_STATUS, outbox, payments } from '../../database/schema';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { captureTraceHeaders } from '../../kafka/trace-context';

export interface ChargePaymentDto {
  orderId: string;
  userId: string;
  /** Stripe token or paymentMethodId from the client. */
  token: string;
}

const PAYABLE_ORDER_STATUSES = new Set(['created', 'awaiting_payment']);
const TERMINAL_PAYMENT_STATUSES = new Set([PAYMENT_STATUS.COMPLETED, PAYMENT_STATUS.FAILED]);
const FAILED_INTENT_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  'canceled',
  'requires_payment_method',
]);

@Injectable()
export class PaymentsService {
  constructor(
    @InjectPinoLogger(PaymentsService.name)
    private readonly logger: PinoLogger,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly orderServiceClient: OrderServiceClient,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
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

  /**
   * Create a new payment for an order.
   * Idempotent: if a payment for the given orderId already exists, returns it.
   */
  async charge(dto: ChargePaymentDto): Promise<Payment> {
    // Idempotency check — Kafka may redeliver the same event
    const existing = await this.paymentsRepo.findByOrderId(dto.orderId);
    if (existing) {
      if (existing.userId !== dto.userId) {
        throw new NotFoundException({
          error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
        });
      }

      if (existing.status === PAYMENT_STATUS.PENDING) {
        this.logger.info(
          { orderId: dto.orderId, paymentId: existing.id },
          'Pending payment already exists — attempting to continue charge',
        );
        return this.confirmPendingPayment(existing, dto.token);
      }

      this.logger.info(
        { orderId: dto.orderId, paymentId: existing.id },
        'Payment already exists — skipping duplicate',
      );
      return existing;
    }

    const order = await this.orderServiceClient.getOrderSnapshot(dto.orderId, dto.userId);
    if (!PAYABLE_ORDER_STATUSES.has(order.status)) {
      throw new ConflictException({
        error: {
          code: 'ORDER_NOT_PAYABLE',
          message: 'Order is not payable in its current state',
        },
      });
    }

    if (this.isMockMode) {
      // Mock path: create payment and write outbox entry atomically
      return this.completeMockPayment(order.orderId, order.userId, order.amount, order.currency);
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
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: order.amount,
          currency: order.currency,
          payment_method: dto.token,
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
      this.logger.error({ paymentId: payment.id, err: msg }, 'Payment failed');

      throw new InternalServerErrorException({
        error: { code: 'PAYMENT_FAILED', message: 'Payment processing failed' },
      });
    }
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
   * In real mode: creates a PENDING payment and initiates a Stripe PaymentIntent.
   * The payment is completed asynchronously via the Stripe webhook handler.
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
        this.logger.info({ orderId: event.orderId }, 'Order already processed — skipping');
        return;
      }

      if (this.isMockMode) {
        // Mock path: create payment as COMPLETED and write outbox entry atomically.
        // This allows the full order flow to complete in local dev and test environments.
        await this.completeMockPayment(
          event.orderId,
          event.userId,
          event.amount,
          event.currency ?? 'usd',
        );
        return;
      }

      // Real Stripe path: create a PENDING payment and initiate a PaymentIntent.
      // The payment will be confirmed via the Stripe webhook (/stripe/webhook).
      const payment = await this.paymentsRepo.create({
        orderId: event.orderId,
        userId: event.userId,
        amount: event.amount,
        currency: event.currency ?? 'usd',
        status: PAYMENT_STATUS.PENDING,
      });

      await this.initiateStripePayment(payment, event.orderId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
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
    this.logger.info({ type: event.type }, 'Stripe webhook received');
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const paymentId = pi.metadata?.paymentId;
        if (paymentId) {
          await this.completeStripePayment(paymentId, pi.id);
        } else {
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
          this.logger.warn(
            { intentId: pf.id },
            'payment_intent.payment_failed: missing paymentId in metadata',
          );
        }
        break;
      }
      default:
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
      this.logger.warn({ paymentId }, 'failStripePayment: payment not found — skipping');
      return;
    }

    if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      this.logger.info(
        { paymentId, currentStatus: payment.status },
        'failStripePayment: payment already terminal — skipping duplicate transition',
      );
      return;
    }

    if (this.hasMismatchedStripeIntentId(payment, stripeIntentId)) {
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

    await this.db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ status: PAYMENT_STATUS.FAILED, updatedAt: new Date() })
        .where(eq(payments.id, paymentId));

      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.failed', payment.orderId, {
          orderId: payment.orderId,
          paymentId,
          userId: payment.userId,
          reason,
        }),
      );
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
      this.logger.warn({ paymentId }, 'completeStripePayment: payment not found — skipping');
      return;
    }

    if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      this.logger.info(
        { paymentId, currentStatus: payment.status },
        'completeStripePayment: payment already terminal — skipping duplicate transition',
      );
      return;
    }

    if (this.hasMismatchedStripeIntentId(payment, stripeIntentId)) {
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

    await this.completePaymentWithOutbox(
      paymentId,
      payment.orderId,
      payment.userId,
      payment.amount,
      payment.currency,
      stripeIntentId,
    );
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
    return payment!;
  }

  private async confirmPendingPayment(payment: Payment, token: string): Promise<Payment> {
    try {
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

    return this.completePaymentWithOutbox(
      payment.id,
      payment.orderId,
      payment.userId,
      payment.amount,
      payment.currency,
      intent.id,
    );
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
  ): Promise<Payment> {
    let updated: Payment | undefined;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(payments)
        .set({
          status: PAYMENT_STATUS.COMPLETED,
          stripePaymentIntentId: stripeIntentId,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, paymentId))
        .returning();
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

    this.logger.info({ paymentId, stripeIntentId }, 'Payment completed — outbox entry written');
    return updated!;
  }

  /**
   * Initiate a Stripe PaymentIntent for a payment that is already in PENDING state.
   * The actual completion happens via the Stripe webhook.
   */
  private async initiateStripePayment(payment: Payment, orderId: string): Promise<void> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: payment.amount,
          currency: payment.currency,
          confirm: false, // confirmed via Stripe.js on the client
          metadata: { orderId, paymentId: payment.id },
        },
        { idempotencyKey: orderId }, // prevents double-charge on retry (fixes R-12)
      );

      await this.paymentsRepo.updateStatus(payment.id, PAYMENT_STATUS.PENDING, intent.id);
      this.logger.info(
        { paymentId: payment.id, intentId: intent.id },
        'Stripe PaymentIntent created',
      );
    } catch (err) {
      await this.paymentsRepo.updateStatus(payment.id, PAYMENT_STATUS.FAILED);
      const msg = err instanceof Error ? err.message : 'Unknown';
      this.logger.error(
        { paymentId: payment.id, err: msg },
        'Stripe PaymentIntent creation failed',
      );
      // Do not re-throw — the payment is now FAILED; the consumer should not retry
    }
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
