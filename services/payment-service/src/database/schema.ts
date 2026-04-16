import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
 * payment_customers table — maps a platform user to a provider customer reference.
 * Never stores PAN/CVV or raw card details.
 */
export const paymentCustomers = pgTable('payment_customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(),
  provider: text('provider').notNull().default('stripe'),
  providerCustomerId: text('provider_customer_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PaymentCustomer = typeof paymentCustomers.$inferSelect;
export type NewPaymentCustomer = typeof paymentCustomers.$inferInsert;

/**
 * saved_payment_methods table — stores only provider references and masked card metadata.
 */
export const savedPaymentMethods = pgTable(
  'saved_payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    paymentCustomerId: uuid('payment_customer_id')
      .notNull()
      .references(() => paymentCustomers.id),
    provider: text('provider').notNull().default('stripe'),
    providerPaymentMethodId: text('provider_payment_method_id').notNull().unique(),
    brand: text('brand').notNull().default('unknown'),
    last4: text('last4').notNull().default('0000'),
    expMonth: integer('exp_month').notNull().default(1),
    expYear: integer('exp_year').notNull().default(1970),
    fingerprint: text('fingerprint'),
    isDefault: boolean('is_default').notNull().default(false),
    consentGivenAt: timestamp('consent_given_at', { withTimezone: true }).notNull(),
    consentVersion: text('consent_version').notNull(),
    consentSource: text('consent_source').notNull(),
    consentIpHash: text('consent_ip_hash'),
    consentUserAgent: text('consent_user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_saved_payment_methods_user_id').on(table.userId),
    index('idx_saved_payment_methods_user_default').on(table.userId, table.isDefault),
    index('idx_saved_payment_methods_payment_customer_id').on(table.paymentCustomerId),
    uniqueIndex('uniq_saved_payment_methods_single_default')
      .on(table.userId)
      .where(sql`${table.isDefault} = true and ${table.deletedAt} is null`),
  ],
);

export type SavedPaymentMethod = typeof savedPaymentMethods.$inferSelect;
export type NewSavedPaymentMethod = typeof savedPaymentMethods.$inferInsert;

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
