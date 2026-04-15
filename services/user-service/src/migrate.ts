import path from "path";
import pino from "pino";
import { runSqlMigrations } from "./common/database/sql-migration-runner";

const log = pino({ base: { service: "user-service" }, messageKey: "message" });

async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error("[migrate] DATABASE_URL is not set — cannot run migrations");
    process.exit(1);
  }

  try {
    await runSqlMigrations({
      advisoryLockId: 41002,
      databaseUrl,
      log,
      migrationsFolder: path.join(__dirname, "..", "migrations"),
    });
  } catch (err) {
    log.error({ err }, "[migrate] Migration failed");
    process.exit(1);
  }
}

void runMigrations();
