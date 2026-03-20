import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Inferred TypeScript type for a row returned from the users table. */
export type User = typeof users.$inferSelect;

/** Inferred TypeScript type for inserting a new user row. */
export type NewUser = typeof users.$inferInsert;
