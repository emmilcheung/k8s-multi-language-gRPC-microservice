import {
  pgTable,
  text,
  timestamp,
  uuid,
  json,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * users table — owned exclusively by auth-service.
 *
 * Convention (AGENTS.md §4.2):
 *  - UUID v4 primary keys
 *  - created_at / updated_at on every table
 *  - Unique constraint named explicitly
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  roles: json('roles').notNull().default([]).$type<string[]>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Inferred TypeScript type for a row returned from the users table. */
export type User = typeof users.$inferSelect;

/** Inferred TypeScript type for inserting a new user row. */
export type NewUser = typeof users.$inferInsert;

/**
 * audit_log — append-only history of permission-checked changes. Same shape in
 * every service. before/after hold only the fields that changed.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text('actor_user_id').notNull(),
    actorAccountId: text('actor_account_id'),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    reason: text('reason'),
    traceId: text('trace_id'),
  },
  (t) => [index('audit_log_resource_at_idx').on(t.resource, t.at.desc())],
);
