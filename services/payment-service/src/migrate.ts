/**
 * Standalone migration entrypoint.
 *
 * Runs all pending SQL migrations from the `migrations/` directory using
 * drizzle-orm's built-in migrator (prod dependency — no drizzle-kit needed).
 * Exits with code 0 on success, code 1 on failure so the container will not
 * start the application if migrations cannot be applied.
 *
 * Usage (from Dockerfile CMD):
 *   node dist/migrate && node dist/main
 */
import pino from 'pino';
import path from 'path';
import { runSqlMigrations } from './common/database/sql-migration-runner';

// Standalone structured logger for the migration script (O-09).
// Uses the same JSON format as the main app without requiring NestJS bootstrap.
const log = pino({ base: { service: 'payment-service' }, messageKey: 'message' });

async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error('[migrate] DATABASE_URL is not set — cannot run migrations');
    process.exit(1);
  }

  try {
    await runSqlMigrations({
      advisoryLockId: 41001,
      databaseUrl,
      log,
      migrationsFolder: path.join(__dirname, '..', 'migrations'),
    });
  } catch (err) {
    log.error({ err }, '[migrate] Migration failed');
    process.exit(1);
  }
}

void runMigrations();
