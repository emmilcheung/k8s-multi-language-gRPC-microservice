/**
 * Integration test for outbox relay concurrency behavior.
 *
 * Verifies that multiple concurrent relay instances use FOR UPDATE SKIP LOCKED
 * to claim disjoint sets of unpublished rows, preventing double-publishing.
 *
 * Spins up a real PostgreSQL container, applies migrations, then exercises
 * the concurrent claim pattern with two overlapping transactions.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, asc } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '../src/database/schema';

const { outbox } = schema;

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('payments_test')
    .withUsername('payments_user')
    .withPassword('payments_pass')
    .start();

  const databaseUrl = pgContainer.getConnectionUri();

  // Initialize pool with enough connections for concurrent transactions
  pool = new Pool({
    connectionString: databaseUrl,
    max: 5, // Allow at least 5 connections for overlapping transactions
  });

  // Initialize drizzle client for schema access
  db = drizzle(pool, { schema });

  // Apply migrations
  const migration1Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/001_init_payments.sql'),
    'utf-8',
  );
  const migration2Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/002_add_outbox.sql'),
    'utf-8',
  );

  const client = await pool.connect();
  try {
    await client.query(migration1Sql);
    await client.query(migration2Sql);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

describe('Outbox relay concurrency', () => {
  it('should claim rows with FOR UPDATE SKIP LOCKED so replicas do not double-publish', async () => {
    // Insert 3 unpublished rows using raw SQL
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO outbox (id, topic, partition_key, payload, trace_headers, published, created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8),
           ($9, $10, $11, $12, $13, $14, $15, $16),
           ($17, $18, $19, $20, $21, $22, $23, $24)`,
        [
          'outbox-concurrent-1',
          'payments.payment.captured',
          'order-1',
          JSON.stringify({
            type: 'payments.payment.captured',
            data: { orderId: 'order-1', paymentId: 'pay-1' },
          }),
          '{}',
          false,
          now,
          now,
          'outbox-concurrent-2',
          'payments.payment.captured',
          'order-2',
          JSON.stringify({
            type: 'payments.payment.captured',
            data: { orderId: 'order-2', paymentId: 'pay-2' },
          }),
          '{}',
          false,
          now,
          now,
          'outbox-concurrent-3',
          'payments.payment.captured',
          'order-3',
          JSON.stringify({
            type: 'payments.payment.captured',
            data: { orderId: 'order-3', paymentId: 'pay-3' },
          }),
          '{}',
          false,
          now,
          now,
        ],
      );
    } finally {
      client.release();
    }

    // Transaction A: claim 2 rows with FOR UPDATE SKIP LOCKED and hold the transaction open
    let transactionARows: Array<{
      id: string;
      topic: string;
      partitionKey: string;
      payload: unknown;
      traceHeaders: unknown;
      published: boolean;
      createdAt: Date;
      updatedAt: Date;
    }> = [];
    let releaseTransactionA: () => Promise<void> = () => Promise.resolve();

    const transactionAPromise = new Promise<void>((resolve, reject) => {
      pool.connect((err, clientA, done) => {
        if (err) {
          reject(err);
          return;
        }

        if (!clientA) {
          reject(new Error('Failed to get database client'));
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          try {
            await clientA.query('BEGIN ISOLATION LEVEL READ COMMITTED');

            const result = await clientA.query(
              `SELECT id, topic, partition_key, payload, trace_headers, published, created_at, updated_at
               FROM outbox
               WHERE published = false
               ORDER BY created_at ASC
               LIMIT 2
               FOR UPDATE SKIP LOCKED`,
            );

            transactionARows = result.rows.map((row) => ({
              id: row.id as string,
              topic: row.topic as string,
              partitionKey: row.partition_key as string,
              payload: row.payload,
              traceHeaders: row.trace_headers,
              published: row.published as boolean,
              createdAt: row.created_at as Date,
              updatedAt: row.updated_at as Date,
            }));

            // Signal that A has claimed rows
            resolve();

            // Hold the transaction open until releaseTransactionA is called
            await new Promise<void>((resolveHold) => {
              releaseTransactionA = async () => {
                await clientA.query('COMMIT');
                resolveHold();
              };
            });
          } catch (error) {
            done(error as Error);
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            done();
          }
        })();
      });
    });

    // Wait for transaction A to claim rows
    await transactionAPromise;

    // Transaction B: while A holds its lock, try to claim with the same query
    const transactionBRows = await db
      .select()
      .from(outbox)

      .where(eq(outbox.published, false))
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      .orderBy(asc(outbox.createdAt))
      .limit(2)
      .for('update', { skipLocked: true });

    // Release transaction A
    await releaseTransactionA();

    // Verify that A and B claimed disjoint sets
    const transactionAIds = new Set(transactionARows.map((r) => r.id));
    const transactionBIds = new Set(transactionBRows.map((r) => r.id));

    // Find overlap
    const overlap = Array.from(transactionAIds).filter((id) => transactionBIds.has(id));

    expect(
      overlap,
      'row claimed by both transactions — SKIP LOCKED not working, replicas will double-publish',
    ).toHaveLength(0);
    expect(
      transactionARows,
      'transaction A should have claimed 2 rows without SKIP LOCKED stopping it',
    ).toHaveLength(2);
    expect(
      transactionBRows.length,
      'transaction B should have claimed at most 1 row because A holds 2; SKIP LOCKED should skip locked rows',
    ).toBeLessThanOrEqual(1);

    // All claimed rows should come from the 3 we inserted
    const allClaimedIds = new Set([...transactionAIds, ...transactionBIds]);
    const insertedIds = new Set([
      'outbox-concurrent-1',
      'outbox-concurrent-2',
      'outbox-concurrent-3',
    ]);

    for (const claimedId of allClaimedIds) {
      expect(insertedIds.has(claimedId), `claimed row ${claimedId} was not in the inserted set`).toBe(true);
    }
  });
});
