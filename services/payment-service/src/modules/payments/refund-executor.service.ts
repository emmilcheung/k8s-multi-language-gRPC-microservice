import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { PAYMENT_STATUS, REFUND_STATUS, outbox, payments, refunds } from '../../database/schema';
import { buildOutboxRow } from './outbox-row';
import { REFUND_PROVIDER, type RefundProvider } from './refund-provider';

const BATCH_SIZE = 10;
/** Attempts before a refund is given up on and needs an operator. */
export const MAX_REFUND_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
const LAST_ERROR_MAX_LENGTH = 500;

/** Only money that was actually taken can be given back. */
const REFUNDABLE_PAYMENT_STATUSES = [PAYMENT_STATUS.COMPLETED, PAYMENT_STATUS.REFUNDED];

type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
type DueRefund = Pick<
  typeof refunds.$inferSelect,
  'id' | 'paymentId' | 'orderId' | 'amount' | 'attempts'
>;

/**
 * Drains the refunds table: every row in REQUESTED is sent to the refund
 * provider until it succeeds or runs out of attempts.
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED, so replicas take disjoint rows,
 * and the provider call happens while the row is locked. A row therefore never
 * sits in an in-between state: if the process dies mid-call, the transaction
 * rolls back and the row is retried. The provider is called with the same
 * idempotency key on every attempt, so a retry after an unseen success returns
 * the original refund instead of refunding twice.
 *
 * The payment only becomes REFUNDED once the provider confirms the refund.
 */
@Injectable()
export class RefundExecutorService {
  private running = false;

  constructor(
    @InjectPinoLogger(RefundExecutorService.name)
    private readonly logger: PinoLogger,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    @Inject(REFUND_PROVIDER) private readonly provider: RefundProvider,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: msg }, 'Refund executor: batch failed');
    } finally {
      this.running = false;
    }
  }

  /** Processes one batch of due refunds. Returns how many rows were handled. */
  async runOnce(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({
          id: refunds.id,
          paymentId: refunds.paymentId,
          orderId: refunds.orderId,
          amount: refunds.amount,
          attempts: refunds.attempts,
        })
        .from(refunds)
        .where(
          and(eq(refunds.status, REFUND_STATUS.REQUESTED), lte(refunds.nextAttemptAt, sql`now()`)),
        )
        .orderBy(asc(refunds.createdAt))
        .limit(BATCH_SIZE)
        .for('update', { skipLocked: true });

      for (const row of due) {
        await this.execute(tx, row);
      }
      return due.length;
    });
  }

  private async execute(tx: DrizzleTx, row: DueRefund): Promise<void> {
    const [payment] = await tx
      .select({
        id: payments.id,
        userId: payments.userId,
        status: payments.status,
        stripePaymentIntentId: payments.stripePaymentIntentId,
      })
      .from(payments)
      .where(eq(payments.id, row.paymentId));

    if (!payment || !(REFUNDABLE_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) {
      await this.fail(tx, row, row.attempts, 'Payment is not in a refundable state');
      return;
    }

    const attempts = row.attempts + 1;
    let providerRefundId: string;
    try {
      ({ providerRefundId } = await this.provider.refund({
        paymentIntentId: payment.stripePaymentIntentId,
        amount: row.amount,
        idempotencyKey: `refund:${row.id}`,
      }));
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(
        0,
        LAST_ERROR_MAX_LENGTH,
      );
      if (attempts >= MAX_REFUND_ATTEMPTS) {
        await this.fail(tx, row, attempts, msg);
      } else {
        await this.scheduleRetry(tx, row, attempts, msg);
      }
      return;
    }

    const now = new Date();
    await tx
      .update(refunds)
      .set({
        status: REFUND_STATUS.COMPLETED,
        stripeRefundId: providerRefundId,
        attempts,
        lastError: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(refunds.id, row.id));
    await tx
      .update(payments)
      .set({ status: PAYMENT_STATUS.REFUNDED, updatedAt: now })
      .where(
        and(eq(payments.id, payment.id), inArray(payments.status, REFUNDABLE_PAYMENT_STATUSES)),
      );
    await tx.insert(outbox).values(
      buildOutboxRow('payments.refund.completed', row.orderId, {
        orderId: row.orderId,
        paymentId: payment.id,
        refundId: row.id,
        userId: payment.userId,
        amount: row.amount,
        providerRefundId,
        provider: this.provider.name,
      }),
    );
    this.logger.info(
      {
        event: 'payment.refund.completed',
        orderId: row.orderId,
        paymentId: payment.id,
        refundId: row.id,
        amount: row.amount,
        provider: this.provider.name,
      },
      'Payment audit event',
    );
  }

  private async scheduleRetry(
    tx: DrizzleTx,
    row: DueRefund,
    attempts: number,
    lastError: string,
  ): Promise<void> {
    const delayMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
    const now = new Date();
    await tx
      .update(refunds)
      .set({
        attempts,
        lastError,
        nextAttemptAt: new Date(now.getTime() + delayMs),
        updatedAt: now,
      })
      .where(eq(refunds.id, row.id));
    this.logger.warn(
      {
        event: 'payment.refund.retry_scheduled',
        orderId: row.orderId,
        refundId: row.id,
        attempts,
        retryInMs: delayMs,
        provider: this.provider.name,
      },
      'Payment audit event',
    );
  }

  private async fail(
    tx: DrizzleTx,
    row: DueRefund,
    attempts: number,
    lastError: string,
  ): Promise<void> {
    await tx
      .update(refunds)
      .set({ status: REFUND_STATUS.FAILED, attempts, lastError, updatedAt: new Date() })
      .where(eq(refunds.id, row.id));
    await tx.insert(outbox).values(
      buildOutboxRow('payments.refund.failed', row.orderId, {
        orderId: row.orderId,
        paymentId: row.paymentId,
        refundId: row.id,
        amount: row.amount,
        attempts,
        provider: this.provider.name,
      }),
    );
    this.logger.error(
      {
        event: 'payment.refund.failed',
        orderId: row.orderId,
        paymentId: row.paymentId,
        refundId: row.id,
        attempts,
        lastError,
        provider: this.provider.name,
      },
      'Payment audit event',
    );
  }
}
