import {
  Injectable,
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import Stripe from 'stripe';
import { Inject } from '@nestjs/common';
import { PaymentsRepository } from './payments.repository';
import { STRIPE_CLIENT } from './stripe.constants';
import { type Payment, PAYMENT_STATUS } from '../../database/schema';

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
  ) {}

  /**
   * Create a new payment for an order.
   * Idempotent: if a payment for the given orderId already exists, returns it.
   */
  async charge(dto: ChargePaymentDto): Promise<Payment> {
    // Idempotency check — Kafka may redeliver the same event
    const existing = await this.paymentsRepo.findByOrderId(dto.orderId);
    if (existing) {
      this.logger.info({ orderId: dto.orderId, paymentId: existing.id }, 'Payment already exists — skipping duplicate');
      return existing;
    }

    // Create the payment row in pending state
    const payment = await this.paymentsRepo.create({
      orderId: dto.orderId,
      userId: dto.userId,
      amount: dto.amount,
      currency: dto.currency ?? 'usd',
      status: PAYMENT_STATUS.PENDING,
    });

    this.logger.info({ paymentId: payment.id, orderId: dto.orderId }, 'Payment created');

    // Fast-path: skip real Stripe when running in mock/test mode
    const stripeKey = this.config.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey === 'test_mock') {
      const updated = await this.paymentsRepo.updateStatus(
        payment.id,
        PAYMENT_STATUS.COMPLETED,
        `mock_pi_${dto.orderId}`,
      );
      this.logger.info({ paymentId: payment.id }, 'Payment completed (mock)');
      return updated;
    }

    try {
      // Create a Stripe PaymentIntent
      const intent = await this.stripe.paymentIntents.create({
        amount: dto.amount,
        currency: dto.currency ?? 'usd',
        payment_method: dto.token,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { orderId: dto.orderId, userId: dto.userId, paymentId: payment.id },
      });

      const updated = await this.paymentsRepo.updateStatus(
        payment.id,
        PAYMENT_STATUS.COMPLETED,
        intent.id,
      );

      this.logger.info(
        { paymentId: payment.id, stripeIntentId: intent.id },
        'Payment completed',
      );
      return updated;
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
   * Uses a mock charge when STRIPE_SECRET_KEY is set to 'test_mock'.
   */
  async processOrderCreatedEvent(event: {
    orderId: string;
    userId: string;
    amount: number;
    currency?: string;
  }): Promise<void> {
    const stripeKey = this.config.get<string>('STRIPE_SECRET_KEY');
    const isMock = stripeKey === 'test_mock';

    this.logger.info(
      { orderId: event.orderId, mock: isMock },
      'Processing order.created event',
    );

    try {
      // Idempotency: if we already processed this order, skip silently
      const existing = await this.paymentsRepo.findByOrderId(event.orderId);
      if (existing) {
        this.logger.info({ orderId: event.orderId }, 'Order already processed — skipping');
        return;
      }

      const payment = await this.paymentsRepo.create({
        orderId: event.orderId,
        userId: event.userId,
        amount: event.amount,
        currency: event.currency ?? 'usd',
        status: isMock ? PAYMENT_STATUS.COMPLETED : PAYMENT_STATUS.PENDING,
        stripePaymentIntentId: isMock ? `mock_pi_${event.orderId}` : undefined,
      });

      this.logger.info(
        { paymentId: payment.id, orderId: event.orderId, status: payment.status },
        'Order event processed',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error({ orderId: event.orderId, err: msg }, 'Failed to process order event');
      // Re-throw so the Kafka consumer can route to DLQ
      throw err;
    }
  }
}
