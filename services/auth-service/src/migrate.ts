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

async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate] DATABASE_URL is not set — cannot run migrations');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const db = drizzle(pool);
    console.log('[migrate] Applying pending migrations…');
    await migrate(db, {
      migrationsFolder: path.join(__dirname, '..', 'migrations'),
    });
    console.log('[migrate] Migrations applied successfully');
  } catch (err) {
    console.error('[migrate] Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void runMigrations();
