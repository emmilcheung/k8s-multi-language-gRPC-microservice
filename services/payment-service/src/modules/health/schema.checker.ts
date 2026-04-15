import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

const REQUIRED_TABLES = [
  'payments',
  'outbox',
  'payment_customers',
  'saved_payment_methods',
] as const;

@Injectable()
export class SchemaChecker {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async verify(): Promise<void> {
    const result = await this.pool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
      `,
      [REQUIRED_TABLES],
    );

    const existingTables = new Set(result.rows.map((row) => row.table_name));
    const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table));

    if (missingTables.length > 0) {
      throw new Error(`Missing required tables: ${missingTables.join(', ')}`);
    }
  }
}

@Injectable()
export class SchemaStartupVerifier implements OnModuleInit {
  constructor(
    private readonly schemaChecker: SchemaChecker,
    private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.schemaChecker.verify();
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err: cause }, 'Payment-service schema verification failed at startup');
      throw cause;
    }
  }
}
