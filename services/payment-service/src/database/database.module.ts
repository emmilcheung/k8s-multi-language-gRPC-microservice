import { Module, Global, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/** Injection token for the typed Drizzle database instance. */
export const DRIZZLE_DB = 'DRIZZLE_DB';

/** Injection token for the underlying pg.Pool (used in integration tests for teardown). */
export const PG_POOL = 'PG_POOL';

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
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool => {
        return new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          statement_timeout: 30_000,
        });
      },
    },
    {
      provide: DRIZZLE_DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): DrizzleDB => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE_DB, PG_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy() {
    await this.pool.end();
  }
}
