/**
 * Integration tests for refund execution against a real PostgreSQL.
 *
 * A refund is a money movement, so these check what the customer and the rest
 * of the platform see: a refund is executed exactly once, the payment only
 * shows as refunded after the provider confirms it, failures are retried with
 * the same idempotency key and finally surface as a failed refund, and an order
 * can never hold two live refunds.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '../src/database/schema';
import {
  MAX_REFUND_ATTEMPTS,
  RefundExecutorService,
} from '../src/modules/payments/refund-executor.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import type { RefundProvider, RefundRequest } from '../src/modules/payments/refund-provider';
import type { DrizzleDB } from '../src/database/database.module';
import type { PinoLogger } from 'nestjs-pino';

const { outbox, payments, refunds, PAYMENT_STATUS, REFUND_STATUS } = schema;

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as PinoLogger;

/** Records every call; fails the first `failures` calls. */
class RecordingProvider implements RefundProvider {
  readonly name = 'simulated' as const;
  calls: RefundRequest[] = [];
  constructor(private failures = 0) {}

  refund(request: RefundRequest): Promise<{ providerRefundId: string }> {
    this.calls.push(request);
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('provider unavailable'));
    }
    return Promise.resolve({ providerRefundId: `re_${request.idempotencyKey}` });
  }
}

function executor(provider: RefundProvider): RefundExecutorService {
  return new RefundExecutorService(logger, db as unknown as DrizzleDB, provider);
}

/** Only enqueueRefund is used, which touches nothing but the database. */
function paymentsService(): PaymentsService {
  const unused = {} as never;
  return new PaymentsService(
    logger,
    unused,
    unused,
    unused,
    unused,
    unused,
    db as unknown as DrizzleDB,
  );
}

async function seedPayment(status: string = PAYMENT_STATUS.COMPLETED) {
  const [payment] = await db
    .insert(payments)
    .values({
      orderId: crypto.randomUUID(),
      userId: 'user-1',
      amount: 4200,
      currency: 'usd',
      status,
      stripePaymentIntentId: 'pi_test_1',
    })
    .returning();
  return payment;
}

async function refundRow(id: string) {
  const [row] = await db
    .select({
      status: refunds.status,
      attempts: refunds.attempts,
      lastError: refunds.lastError,
      stripeRefundId: refunds.stripeRefundId,
      completedAt: refunds.completedAt,
      nextAttemptAt: refunds.nextAttemptAt,
    })
    .from(refunds)
    .where(eq(refunds.id, id));
  return row;
}

async function paymentStatus(id: string) {
  const [row] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.id, id));
  return row.status;
}

async function outboxTopics(orderId: string) {
  const rows = await db
    .select({ topic: outbox.topic })
    .from(outbox)
    .where(eq(outbox.partitionKey, orderId));
  return rows.map((r) => r.topic).sort();
}

/** Makes a scheduled retry due now. */
async function makeDue(id: string) {
  await db
    .update(refunds)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(refunds.id, id));
}

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('payments_test')
    .withUsername('payments_user')
    .withPassword('payments_pass')
    .start();

  pool = new Pool({ connectionString: pgContainer.getConnectionUri(), max: 5 });
  db = drizzle(pool, { schema });

  const migrationsDir = path.join(__dirname, '../migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
});

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE refunds, outbox, payments CASCADE');
});

describe('Refund execution', () => {
  it('refund executor should refund once and mark the payment refunded when the provider succeeds', async () => {
    const payment = await seedPayment();
    const refund = await paymentsService().enqueueRefund(payment, 'Order could not be fulfilled');
    expect(refund).not.toBeNull();
    // Nothing has been paid back yet, so the payment must not claim otherwise.
    expect(await paymentStatus(payment.id)).toBe(PAYMENT_STATUS.COMPLETED);

    const provider = new RecordingProvider();
    expect(await executor(provider).runOnce()).toBe(1);
    // A second pass must not refund again.
    expect(await executor(provider).runOnce()).toBe(0);

    expect(provider.calls).toEqual([
      { paymentIntentId: 'pi_test_1', amount: 4200, idempotencyKey: `refund:${refund!.id}` },
    ]);
    const row = await refundRow(refund!.id);
    expect(row.status).toBe(REFUND_STATUS.COMPLETED);
    expect(row.stripeRefundId).toBe(`re_refund:${refund!.id}`);
    expect(row.completedAt).not.toBeNull();
    expect(await paymentStatus(payment.id)).toBe(PAYMENT_STATUS.REFUNDED);
    expect(await outboxTopics(payment.orderId)).toEqual([
      'payments.refund.completed',
      'payments.refund.requested',
    ]);
  });

  it('refund executor should retry with the same idempotency key when the provider fails once', async () => {
    const payment = await seedPayment();
    const refund = await paymentsService().enqueueRefund(payment, 'Order could not be fulfilled');
    const provider = new RecordingProvider(1);

    await executor(provider).runOnce();
    const afterFailure = await refundRow(refund!.id);
    expect(afterFailure.status).toBe(REFUND_STATUS.REQUESTED);
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.lastError).toBe('provider unavailable');
    // Backed off: not picked up again straight away.
    expect(afterFailure.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await executor(provider).runOnce()).toBe(0);

    await makeDue(refund!.id);
    await executor(provider).runOnce();

    expect(provider.calls.map((c) => c.idempotencyKey)).toEqual([
      `refund:${refund!.id}`,
      `refund:${refund!.id}`,
    ]);
    const done = await refundRow(refund!.id);
    expect(done.status).toBe(REFUND_STATUS.COMPLETED);
    expect(done.attempts).toBe(2);
    expect(done.lastError).toBeNull();
    expect(await paymentStatus(payment.id)).toBe(PAYMENT_STATUS.REFUNDED);
  });

  it('refund executor should mark the refund failed and emit refund failed when every attempt fails', async () => {
    const payment = await seedPayment();
    const refund = await paymentsService().enqueueRefund(payment, 'Order could not be fulfilled');
    const provider = new RecordingProvider(Number.MAX_SAFE_INTEGER);

    for (let i = 0; i < MAX_REFUND_ATTEMPTS; i++) {
      await makeDue(refund!.id);
      await executor(provider).runOnce();
    }
    await makeDue(refund!.id);
    expect(await executor(provider).runOnce()).toBe(0);

    expect(provider.calls).toHaveLength(MAX_REFUND_ATTEMPTS);
    const row = await refundRow(refund!.id);
    expect(row.status).toBe(REFUND_STATUS.FAILED);
    expect(row.attempts).toBe(MAX_REFUND_ATTEMPTS);
    // The customer was not paid back, so the payment must not say they were.
    expect(await paymentStatus(payment.id)).toBe(PAYMENT_STATUS.COMPLETED);
    expect(await outboxTopics(payment.orderId)).toEqual([
      'payments.refund.failed',
      'payments.refund.requested',
    ]);
  });

  it('refund executor should fail the refund without calling the provider when the payment was never captured', async () => {
    const payment = await seedPayment(PAYMENT_STATUS.FAILED);
    const refund = await paymentsService().enqueueRefund(payment, 'Order could not be fulfilled');
    const provider = new RecordingProvider();

    await executor(provider).runOnce();

    expect(provider.calls).toHaveLength(0);
    expect((await refundRow(refund!.id)).status).toBe(REFUND_STATUS.FAILED);
    expect(await outboxTopics(payment.orderId)).toContain('payments.refund.failed');
  });

  it('concurrent refund executors should refund each row once when they run at the same time', async () => {
    const seeded = await Promise.all([1, 2, 3, 4, 5].map(() => seedPayment()));
    for (const payment of seeded) {
      await paymentsService().enqueueRefund(payment, 'Order could not be fulfilled');
    }
    const provider = new RecordingProvider();

    await Promise.all([executor(provider).runOnce(), executor(provider).runOnce()]);
    await executor(provider).runOnce();

    const keys = provider.calls.map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
  });

  it('enqueueRefund should create one refund when the same order is refunded concurrently', async () => {
    const payment = await seedPayment();

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        paymentsService().enqueueRefund(payment, 'Order could not be fulfilled'),
      ),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const rows = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.orderId, payment.orderId));
    expect(rows).toHaveLength(1);
    expect(await outboxTopics(payment.orderId)).toEqual(['payments.refund.requested']);
  });

  it('enqueueRefund should allow a new refund when the previous one failed', async () => {
    const payment = await seedPayment();
    const first = await paymentsService().enqueueRefund(payment, 'first');
    await db.update(refunds).set({ status: REFUND_STATUS.FAILED }).where(eq(refunds.id, first!.id));

    const second = await paymentsService().enqueueRefund(payment, 'second');

    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });
});
