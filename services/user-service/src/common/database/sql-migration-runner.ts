import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { Pool } from "pg";

const MIGRATIONS_TABLE = "schema_migrations";

type RunSqlMigrationsOptions = {
  advisoryLockId: number;
  databaseUrl: string;
  log: Logger;
  migrationsFolder: string;
};

function checksumFor(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function listMigrationFiles(migrationsFolder: string): Promise<string[]> {
  const entries = await readdir(migrationsFolder, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`No SQL migration files found in ${migrationsFolder}`);
  }

  return files;
}

export async function runSqlMigrations({
  advisoryLockId,
  databaseUrl,
  log,
  migrationsFolder,
}: RunSqlMigrationsOptions): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    const migrationFiles = await listMigrationFiles(migrationsFolder);

    log.info({ migrationFiles }, "[migrate] Applying pending SQL migrations");

    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockId]);

    const { rows } = await client.query<{
      checksum: string;
      filename: string;
    }>(`SELECT filename, checksum FROM ${MIGRATIONS_TABLE}`);

    const appliedMigrations = new Map(
      rows.map((row) => [row.filename, row.checksum]),
    );

    let appliedCount = 0;

    for (const filename of migrationFiles) {
      const filePath = path.join(migrationsFolder, filename);
      const sql = await readFile(filePath, "utf8");
      const checksum = checksumFor(sql);
      const appliedChecksum = appliedMigrations.get(filename);

      if (appliedChecksum) {
        if (appliedChecksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${filename}; refusing to continue`,
          );
        }

        continue;
      }

      log.info({ filename }, "[migrate] Running migration");
      await client.query(sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (filename, checksum) VALUES ($1, $2)`,
        [filename, checksum],
      );
      appliedCount += 1;
    }

    await client.query("COMMIT");
    log.info({ appliedCount }, "[migrate] SQL migrations applied successfully");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
