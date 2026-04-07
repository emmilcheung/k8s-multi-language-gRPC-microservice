import { pgTable, text, timestamp, uuid, integer, boolean, jsonb } from 'drizzle-orm/pg-core';

/**
 * payments table — owned exclusively by payment-service.
 *
 * Convention (AGENTS.md §4.2):
 *  - UUID v4 primary keys
 *  - created_at / updated_at on every table
 *  - Constraints named explicitly
 */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().unique(),
  userId: text('user_id').notNull(),
  /** Amount in the smallest currency unit (e.g. cents for USD). */
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status').notNull().default('pending'),
  /** Stripe PaymentIntent id — set once the charge is created. */
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

/** Allowed payment status values. */
export const PAYMENT_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/**
 * outbox table — transactional outbox for reliable Kafka event publishing.
 *
 * Rows are written atomically with the payment status update (same DB transaction).
 * The OutboxRelayService cron reads unpublished rows and publishes them to Kafka,
 * then marks them published. This guarantees at-least-once delivery even if the
 * process crashes between the DB write and the Kafka send.
 */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  topic: text('topic').notNull(),
  /** CloudEvents envelope as JSONB. */
  payload: jsonb('payload').notNull(),
  /** Persisted W3C trace headers restored by the outbox relay at publish time. */
  traceHeaders: jsonb('trace_headers').$type<Record<string, string>>().notNull(),
  /** Kafka partition key — typically the orderId for per-order ordering. */
  partitionKey: text('partition_key').notNull(),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = typeof outbox.$inferInsert;
