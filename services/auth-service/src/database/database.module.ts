import { Module, Global, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/** Injection token for the typed Drizzle database instance. */
export const DRIZZLE_DB = 'DRIZZLE_DB';

/** Convenience type alias used throughout the codebase. */
export type DrizzleDB = NodePgDatabase<typeof schema>;

/**
 * Global module that provides a single Drizzle db instance backed by a pg.Pool.
 * Owns the pool lifecycle — closes it on module destroy (graceful shutdown).
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DrizzleDB => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: config.get<number>('DB_POOL_MAX', 20),
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          statement_timeout: 30_000,
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE_DB],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async onModuleDestroy() {
    // Access the underlying pool via the Drizzle session and close it
    const pool = (this.db as unknown as { session: { client: Pool } }).session
      ?.client;
    if (pool && typeof pool.end === 'function') {
      await pool.end();
    }
  }
}
