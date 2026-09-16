/**
 * Integration test for outbox relay concurrency behavior.
 *
 * Verifies that OutboxRelayService drives two concurrent relay instances against
 * a real database and uses FOR UPDATE SKIP LOCKED to claim disjoint sets of
 * unpublished rows, preventing double-publishing.
 *
 * The test constructs the service directly (not via NestJS), injects stub
 * dependencies, and exercises the relay() method concurrently with controlled
 * producer gates to verify that SKIP LOCKED prevents duplicate publishes.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from '../src/database/schema';
import { OutboxRelayService } from '../src/modules/payments/outbox-relay.service';
import type { PinoLogger } from 'nestjs-pino';
import type { ConfigService } from '@nestjs/config';

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
    max: 5,
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
  const migration3Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/003_add_outbox_trace_headers.sql'),
    'utf-8',
  );

  const client = await pool.connect();
  try {
    await client.query(migration1Sql);
    await client.query(migration2Sql);
    await client.query(migration3Sql);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

describe('Outbox relay concurrency', () => {
  it('should drive the real relay service and prevent double-publish with SKIP LOCKED', async () => {
    // Insert 3 unpublished outbox rows
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO outbox (id, topic, partition_key, payload, trace_headers, published, created_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7),
           ($8, $9, $10, $11, $12, $13, $14),
           ($15, $16, $17, $18, $19, $20, $21)`,
        [
          '11111111-1111-4111-8111-111111111111',
          'payments.payment.captured',
          'order-1',
          JSON.stringify({
            type: 'payments.payment.captured',
            data: { orderId: 'order-1', paymentId: 'pay-1' },
          }),
          '{}',
          false,
          now,
          '22222222-2222-4222-8222-222222222222',
          'payments.payment.captured',
          'order-2',
          JSON.stringify({
            type: 'payments.payment.captured',
            data: { orderId: 'order-2', paymentId: 'pay-2' },
          }),
          '{}',
          false,
          now,
          '33333333-3333-4333-8333-333333333333',
          'payments.payment.captured',
          'order-3',
          JSON.stringify({
            type: 'payments.payment.captured',
            data: { orderId: 'order-3', paymentId: 'pay-3' },
          }),
          '{}',
          false,
          now,
        ],
      );
    } finally {
      client.release();
    }

    // Build stub logger (no-op functions)
    const stubLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as PinoLogger;

    // Build stub config (returns undefined for all gets)
    const stubConfig = {
      get: () => undefined,
    } as unknown as ConfigService;

    // Track messages sent by each relay
    const relayAMessages: Array<{ key: string; value: string }> = [];
    const relayBMessages: Array<{ key: string; value: string }> = [];

    // Gate: relayA's first producer.send() will block until relayB finishes
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    let relayAHasEnteredSend = false;

    // Fake producer for relay A: blocks on first send
    const fakeProducerA = {
      send: async (args: any) => {
        relayAMessages.push({
          key: args.messages[0].key as string,
          value: args.messages[0].value as string,
        });

        if (!relayAHasEnteredSend) {
          relayAHasEnteredSend = true;
          // Signal that we've entered send, then wait for gate
          await gate;
        }
      },
    };

    // Fake producer for relay B: returns immediately
    const fakeProducerB = {
      // eslint-disable-next-line @typescript-eslint/require-await
      send: async (args: any) => {
        relayBMessages.push({
          key: args.messages[0].key as string,
          value: args.messages[0].value as string,
        });
      },
    };

    // Construct relay service instances
    const relayA = new OutboxRelayService(stubLogger, stubConfig, db);
    const relayB = new OutboxRelayService(stubLogger, stubConfig, db);

    // Set kafkaAvailable and producer via bracket access for both relays
    (relayA as any).kafkaAvailable = true;
    (relayA as any).producer = fakeProducerA;
    (relayB as any).kafkaAvailable = true;
    (relayB as any).producer = fakeProducerB;

    // Start relay A without awaiting
    const relayAPromise = relayA.relay();

    // Wait for relay A to enter its first producer.send()
    let attempts = 0;
    while (!relayAHasEnteredSend && attempts < 100) {
      await new Promise((r) => setTimeout(r, 10));
      attempts++;
    }

    expect(relayAHasEnteredSend, 'relay A should have entered producer.send').toBe(true);

    // While relay A is blocked in producer.send, relay B runs to completion
    await relayB.relay();

    // Verify relay B got no rows (all were locked by relay A)
    expect(
      relayBMessages.length,
      'relay B should have claimed 0 rows because all were locked by relay A',
    ).toBe(0);

    // Release relay A's gate
    resolveGate();

    // Await relay A to complete
    await relayAPromise;

    // Combine messages from both relays
    const allMessages = [...relayAMessages, ...relayBMessages];

    // Assertion 1: Total message count should be 3 (each row published once)
    expect(
      allMessages.length,
      'total send calls should be exactly 3 (each row published once)',
    ).toBe(3);

    // Assertion 2: Relay A should have published all 3 rows
    expect(relayAMessages.length, 'relay A should have published all 3 unpublished rows').toBe(3);

    // Assertion 3: Query database to verify which rows are marked published
    const publishedRows = await db.select().from(outbox).where(eq(outbox.published, true));
    const publishedRowIds = new Set(publishedRows.map((r) => r.id));

    // Assertion 4: Should have exactly 3 published rows (no duplicates)
    expect(
      publishedRows.length,
      'all 3 outbox rows should be marked as published after relay completes',
    ).toBe(3);

    expect(
      publishedRowIds.size,
      'should have exactly 3 unique published row IDs (no duplicates)',
    ).toBe(3);

    // Assertion 5: Verify all 3 original IDs were published
    const expectedIds = new Set([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);

    for (const publishedId of publishedRowIds) {
      expect(
        expectedIds.has(publishedId),
        `published row id ${publishedId} should be one of the original 3 inserted rows`,
      ).toBe(true);
    }

    // Assertion 6: Verify no unpublished rows remain
    const unpublishedRows = await db.select().from(outbox).where(eq(outbox.published, false));
    expect(
      unpublishedRows.length,
      'all outbox rows should be published, none should remain unpublished',
    ).toBe(0);
  });
});
