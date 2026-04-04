import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { PaymentsRepository } from './payments.repository';
import { STRIPE_CLIENT } from './stripe.constants';
import { type Payment, PAYMENT_STATUS, outbox, payments } from '../../database/schema';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';

export interface ChargePaymentDto {
  orderId: string;
  userId: string;
  /** Amount in the smallest currency unit (cents). */
  amount: number;
  currency?: string;
  /** Stripe token or paymentMethodId from the client. */
  token: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    @InjectPinoLogger(PaymentsService.name)
    private readonly logger: PinoLogger,
    private readonly paymentsRepo: PaymentsRepository,
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
      this.logger.info(
        { orderId: dto.orderId, paymentId: existing.id },
        'Payment already exists — skipping duplicate',
      );
      return existing;
    }

    if (this.isMockMode) {
      // Mock path: create payment and write outbox entry atomically
      return this.completeMockPayment(dto.orderId, dto.userId, dto.amount, dto.currency ?? 'usd');
    }

    // Real Stripe path: create PENDING first, then attempt charge
    const payment = await this.paymentsRepo.create({
      orderId: dto.orderId,
      userId: dto.userId,
      amount: dto.amount,
      currency: dto.currency ?? 'usd',
      status: PAYMENT_STATUS.PENDING,
    });

    this.logger.info({ paymentId: payment.id, orderId: dto.orderId }, 'Payment created (pending)');

    // Publish payment.initiated event to notify order-service to transition to AWAITING_PAYMENT
    await this.db.transaction(async (tx) => {
      await tx.insert(outbox).values(
        this.buildOutboxRow('payments.payment.initiated', dto.orderId, {
          orderId: dto.orderId,
          paymentId: payment.id,
          userId: dto.userId,
          amount: dto.amount,
          currency: dto.currency ?? 'usd',
        }),
      );
    });

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: dto.amount,
          currency: dto.currency ?? 'usd',
          payment_method: dto.token,
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { orderId: dto.orderId, userId: dto.userId, paymentId: payment.id },
        },
        { idempotencyKey: dto.orderId }, // prevents double-charge on retry (fixes R-12)
      );

      // Mark complete and write outbox in the same transaction
      return this.completePaymentWithOutbox(
        payment.id,
        dto.orderId,
        dto.userId,
        dto.amount,
        dto.currency ?? 'usd',
        intent.id,
      );
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
   * Complete a real Stripe payment and publish the outbox event atomically.
   * Called from the Stripe webhook handler once a PaymentIntent is confirmed.
   */
  async completeStripePayment(paymentId: string, stripeIntentId: string): Promise<void> {
    const payment = await this.paymentsRepo.findById(paymentId);
    if (!payment) {
      this.logger.warn({ paymentId }, 'completeStripePayment: payment not found — skipping');
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
}
