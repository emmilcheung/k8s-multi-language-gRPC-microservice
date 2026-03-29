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
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'path';
import pino from 'pino';

// Standalone structured logger for the migration script (O-09).
// Uses the same JSON format as the main app without requiring NestJS bootstrap.
const log = pino({ base: { service: 'payment-service' }, messageKey: 'message' });

async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error('[migrate] DATABASE_URL is not set — cannot run migrations');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const db = drizzle(pool);
    log.info('[migrate] Applying pending migrations…');
    await migrate(db, {
      migrationsFolder: path.join(__dirname, '..', 'migrations'),
    });
    log.info('[migrate] Migrations applied successfully');
  } catch (err) {
    log.error({ err }, '[migrate] Migration failed');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void runMigrations();
