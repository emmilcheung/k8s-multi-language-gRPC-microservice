import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * Used for:
 *  - `drizzle-kit generate` — generates SQL migration files from schema changes
 *  - `drizzle-kit migrate`  — applies pending migrations to the database
 *  - `drizzle-kit studio`   — local DB browser (dev only)
 *
 * DATABASE_URL must be set in the environment before running any drizzle-kit command.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL env var is required for drizzle-kit'); })(),
  },
  verbose: true,
  strict: true,
});
