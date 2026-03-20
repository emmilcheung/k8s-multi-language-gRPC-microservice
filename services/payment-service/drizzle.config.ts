import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for payment-service.
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
