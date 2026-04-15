/**
 * Integration tests for payment-service HTTP API.
 *
 * Spins up a real PostgreSQL container via Testcontainers, applies the SQL
 * migration, bootstraps the full NestJS application (without Kafka consumer
 * and with a mock Stripe client), and exercises endpoints over real HTTP.
 *
 * Each describe block cleans up its own data via DELETE statements so tests
 * remain isolated without needing separate schemas.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Logger, LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs';
import * as path from 'path';
import supertest from 'supertest';

import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { DatabaseModule } from '../src/database/database.module';
import { PaymentsModule } from '../src/modules/payments/payments.module';
import { OutboxRelayService } from '../src/modules/payments/outbox-relay.service';
import { OrderServiceClient } from '../src/modules/payments/order-service.client';
import { HealthModule } from '../src/modules/health/health.module';
import { KafkaChecker } from '../src/modules/health/kafka.checker';
import { STRIPE_CLIENT } from '../src/modules/payments/stripe.constants';

// ── Suite setup / teardown ────────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let app: INestApplication;
let pool: Pool;
let request: ReturnType<typeof supertest>;

/** Minimal Stripe mock — no real network calls in tests. */
const mockStripe = {
  paymentIntents: {
    create: ({
      amount,
      currency,
      metadata,
    }: {
      amount: number;
      currency: string;
      metadata: Record<string, string>;
    }) =>
      Promise.resolve({
        id: `mock_pi_${metadata.orderId ?? 'unknown'}`,
        amount,
        currency,
        status: 'succeeded',
      }),
  },
};

const mockKafkaChecker = {
  ping: () => Promise.resolve(),
};

const orderAmountsById: Record<string, number> = {
  '6e65651c-0424-475c-b491-82bc26e7818a': 2000,
  'aa7b17d0-398c-4fcb-abe6-9be62cee1769': 1500,
  'c238b3f5-5ce7-430f-a4d2-ad8e3a946a4e': 3000,
  'f72fe9be-0e9e-47a5-bd3e-47d4f09de0e1': 4200,
};

const mockOrderServiceClient = {
  getOrderSnapshot: vi.fn().mockImplementation((orderId: string, userId: string) =>
    Promise.resolve({
      orderId,
      userId,
      status: 'created',
      amount: orderAmountsById[orderId] ?? 1000,
      currency: 'usd',
    }),
  ),
};

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('payments_test')
    .withUsername('payments_user')
    .withPassword('payments_pass')
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['ORDER_SERVICE_URL'] = 'http://order-service:8082';
  process.env['STRIPE_SECRET_KEY'] = 'test_mock';
  process.env['KAFKA_BROKERS'] = 'localhost:9092';
  process.env['NODE_ENV'] = 'test';

  // Apply migrations
  pool = new Pool({ connectionString: databaseUrl });
  const migration1Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/001_init_payments.sql'),
    'utf-8',
  );
  const migration2Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/002_add_outbox.sql'),
    'utf-8',
  );
  const migration4Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/004_add_saved_payment_methods.sql'),
    'utf-8',
  );
  const migration5Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/005_harden_saved_payment_methods.sql'),
    'utf-8',
  );
  await pool.query(migration1Sql);
  await pool.query(migration2Sql);
  await pool.query(migration4Sql);
  await pool.query(migration5Sql);

  // Bootstrap NestJS without pino pretty and with mocked Stripe + Kafka consumer
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validate: (config: Record<string, unknown>) => {
          const result = z
            .object({
              DATABASE_URL: z.string(),
              ORDER_SERVICE_URL: z.string().url(),
              STRIPE_SECRET_KEY: z.string(),
              KAFKA_BROKERS: z.string(),
              NODE_ENV: z.string().default('test'),
            })
            .safeParse(config);
          if (!result.success) throw new Error(result.error.message);
          return result.data;
        },
        ignoreEnvFile: true,
      }),
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      DatabaseModule,
      PaymentsModule,
      HealthModule,
    ],
  })
    .overrideProvider(STRIPE_CLIENT)
    .useValue(mockStripe)
    .overrideProvider(OrderServiceClient)
    .useValue(mockOrderServiceClient)
    .overrideProvider(KafkaChecker)
    .useValue(mockKafkaChecker)
    .overrideProvider(OutboxRelayService)
    .useValue({ onModuleInit: async () => {}, onModuleDestroy: async () => {} })
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(Logger)));

  await app.init();
  const httpServer = app.getHttpServer() as Parameters<typeof supertest>[0];
  request = supertest(httpServer);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await pgContainer?.stop();
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function cleanPayments() {
  await pool.query('DELETE FROM outbox');
  await pool.query('DELETE FROM payments');
  await pool.query('DELETE FROM saved_payment_methods');
  await pool.query('DELETE FROM payment_customers');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/payments returns 201 Created given valid input and X-User-Id header', () => {
  beforeAll(cleanPayments);

  it('should create a payment and return it', async () => {
    const res = await request.post('/api/payments').set('X-User-Id', 'user-integration-1').send({
      orderId: '6e65651c-0424-475c-b491-82bc26e7818a',
      token: 'pm_test_ok',
    });

    expect(res.status).toBe(201);
    expect(res.body.payment.orderId).toBe('6e65651c-0424-475c-b491-82bc26e7818a');
    expect(res.body.payment.amount).toBe(2000);
    expect(res.body.payment.status).toBe('completed');
    expect(res.body.payment.id).toBeDefined();
  });
});

describe('POST /api/payments returns 201 and is idempotent when called twice with same orderId', () => {
  beforeAll(cleanPayments);

  it('should return the same payment on duplicate request', async () => {
    const body = {
      orderId: 'aa7b17d0-398c-4fcb-abe6-9be62cee1769',
      token: 'pm_test_ok',
    };
    const r1 = await request.post('/api/payments').set('X-User-Id', 'user-1').send(body);
    const r2 = await request.post('/api/payments').set('X-User-Id', 'user-1').send(body);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.payment.id).toBe(r2.body.payment.id);
  });
});

describe('POST /api/payments returns 500 when mock mode receives a declined token', () => {
  beforeAll(cleanPayments);

  it('should persist a failed payment and emit a failed outbox event', async () => {
    const orderId = '0f3f98dd-1dc1-4d5c-97f6-12663cda7d25';

    const res = await request.post('/api/payments').set('X-User-Id', 'user-fail-1').send({
      orderId,
      token: 'pm_mock_declined',
    });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PAYMENT_FAILED');
    expect(res.body.error.message).toBe('Mock payment declined');

    const paymentRows = await pool.query(
      'SELECT status, stripe_payment_intent_id FROM payments WHERE order_id = $1',
      [orderId],
    );
    expect(paymentRows.rows).toHaveLength(1);
    expect(paymentRows.rows[0]?.status).toBe('failed');
    expect(paymentRows.rows[0]?.stripe_payment_intent_id).toBe(`mock_pi_failed_${orderId}`);

    const outboxRows = await pool.query<{ topic: string }>(
      'SELECT topic FROM outbox WHERE partition_key = $1 ORDER BY created_at ASC',
      [orderId],
    );
    expect(outboxRows.rows.map((row) => row.topic)).toContain('payments.payment.failed');
  });
});

describe('POST /api/payments returns 400 when X-User-Id header is missing', () => {
  it('should reject the request without X-User-Id', async () => {
    const res = await request
      .post('/api/payments')
      .send({ orderId: '06750fa4-2de3-4831-8a3d-e8ccf081a168', token: 'pm_x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_USER_ID');
  });
});

describe('POST /api/payments returns 400 given invalid body', () => {
  it('should reject missing token', async () => {
    const res = await request
      .post('/api/payments')
      .set('X-User-Id', 'user-1')
      .send({ orderId: 'ab0a6bb5-e7f9-4455-b3ea-6e8cf218c526' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('should reject a non-UUID orderId', async () => {
    const res = await request
      .post('/api/payments')
      .set('X-User-Id', 'user-1')
      .send({ orderId: 'not-a-uuid', token: 'pm_x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('should reject legacy client-authoritative amount fields', async () => {
    const res = await request.post('/api/payments').set('X-User-Id', 'user-1').send({
      orderId: '0a6a4658-acf6-42a9-936e-5ee155f96418',
      amount: 500,
      token: 'pm_x',
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/payments/:id returns 200 OK given valid payment id', () => {
  let paymentId: string;

  beforeAll(async () => {
    await cleanPayments();
    const res = await request
      .post('/api/payments')
      .set('X-User-Id', 'user-get-1')
      .send({ orderId: 'c238b3f5-5ce7-430f-a4d2-ad8e3a946a4e', token: 'pm_ok' });
    paymentId = res.body.payment.id as string;
  });

  it('should return the payment', async () => {
    const res = await request.get(`/api/payments/${paymentId}`).set('X-User-Id', 'user-get-1');

    expect(res.status).toBe(200);
    expect(res.body.payment.id).toBe(paymentId);
    expect(res.body.payment.amount).toBe(3000);
  });
});

describe('GET /api/payments/:id returns 404 Not Found given unknown id', () => {
  it('should return 404 for a non-existent payment', async () => {
    const res = await request
      .get('/api/payments/26088992-98b5-403f-8d75-3af190c8265c')
      .set('X-User-Id', 'some-user');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });
});

describe('GET /healthz/live', () => {
  it('should return 200 OK', async () => {
    const res = await request.get('/healthz/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /healthz/ready', () => {
  it('should return 200 OK when database is reachable', async () => {
    const res = await request.get('/healthz/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Saved payment methods lifecycle endpoints', () => {
  const userId = 'user-methods-1';

  beforeAll(cleanPayments);

  it('POST /api/payments/methods/register should create a method and GET /methods should return it', async () => {
    const register = await request
      .post('/api/payments/methods/register')
      .set('X-User-Id', userId)
      .send({
        providerPaymentMethodId: 'pm_mock_card_4242',
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      });

    expect(register.status).toBe(201);
    expect(register.body.paymentMethod.id).toBeDefined();
    expect(register.body.paymentMethod.providerPaymentMethodId).toBeUndefined();
    expect(register.body.paymentMethod.paymentCustomerId).toBeUndefined();
    expect(register.body.paymentMethod.fingerprint).toBeUndefined();
    expect(register.body.paymentMethod.isDefault).toBe(true);

    const list = await request.get('/api/payments/methods').set('X-User-Id', userId);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.paymentMethods)).toBe(true);
    expect(list.body.paymentMethods).toHaveLength(1);
    expect(list.body.paymentMethods[0]?.providerPaymentMethodId).toBeUndefined();
  });

  it('PATCH /api/payments/methods/:id/default should enforce a single default', async () => {
    const first = await request
      .post('/api/payments/methods/register')
      .set('X-User-Id', userId)
      .send({
        providerPaymentMethodId: 'pm_mock_card_1111',
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      });

    const second = await request
      .post('/api/payments/methods/register')
      .set('X-User-Id', userId)
      .send({
        providerPaymentMethodId: 'pm_mock_card_2222',
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      });

    const secondId = second.body.paymentMethod.id as string;
    const patch = await request
      .patch(`/api/payments/methods/${secondId}/default`)
      .set('X-User-Id', userId)
      .send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(patch.status).toBe(200);
    expect(patch.body.paymentMethod.id).toBe(secondId);
    expect(patch.body.paymentMethod.last4).toBe('2222');
    expect(patch.body.paymentMethod.expMonth).toBe(12);
    expect(patch.body.paymentMethod.expYear).toBe(2099);
    expect(patch.body.paymentMethod.isDefault).toBe(true);

    const rows = await pool.query<{ id: string; is_default: boolean }>(
      'SELECT id, is_default FROM saved_payment_methods WHERE user_id = $1 AND deleted_at IS NULL',
      [userId],
    );
    const defaultRows = rows.rows.filter((row) => row.is_default);
    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0]?.id).toBe(secondId);
  });

  it('DELETE /api/payments/methods/:id should soft delete and hide from list', async () => {
    const register = await request
      .post('/api/payments/methods/register')
      .set('X-User-Id', userId)
      .send({
        providerPaymentMethodId: 'pm_mock_card_3333',
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      });

    const methodId = register.body.paymentMethod.id as string;
    const del = await request
      .delete(`/api/payments/methods/${methodId}`)
      .set('X-User-Id', userId)
      .send({});

    expect(del.status).toBe(204);

    const list = await request.get('/api/payments/methods').set('X-User-Id', userId);
    expect(list.status).toBe(200);
    const paymentMethods: Array<{ id: string }> = Array.isArray(list.body.paymentMethods)
      ? (list.body.paymentMethods as Array<{ id: string }>)
      : [];
    expect(paymentMethods.some((method) => method.id === methodId)).toBe(false);

    const dbRow = await pool.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM saved_payment_methods WHERE id = $1',
      [methodId],
    );
    expect(dbRow.rows).toHaveLength(1);
    expect(dbRow.rows[0]?.deleted_at).not.toBeNull();
  });

  it('POST /api/payments should accept savedPaymentMethodId and charge successfully', async () => {
    const chargeUserId = 'user-saved-charge-1';
    const register = await request
      .post('/api/payments/methods/register')
      .set('X-User-Id', chargeUserId)
      .send({
        providerPaymentMethodId: 'pm_mock_card_9000',
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: 'settings-card-save-v1',
      });

    const savedPaymentMethodId = register.body.paymentMethod.id as string;

    const charge = await request.post('/api/payments').set('X-User-Id', chargeUserId).send({
      orderId: 'f72fe9be-0e9e-47a5-bd3e-47d4f09de0e1',
      savedPaymentMethodId,
    });

    expect(charge.status).toBe(201);
    expect(charge.body.payment.orderId).toBe('f72fe9be-0e9e-47a5-bd3e-47d4f09de0e1');
    expect(charge.body.payment.amount).toBe(4200);
    expect(charge.body.payment.status).toBe('completed');
  });

  it('methods endpoints should reject missing X-User-Id', async () => {
    const register = await request.post('/api/payments/methods/register').send({
      providerPaymentMethodId: 'pm_mock_card_5555',
      setAsDefault: false,
      consentAccepted: true,
      consentVersion: 'settings-card-save-v1',
    });
    expect(register.status).toBe(400);
    expect(register.body.error.code).toBe('MISSING_USER_ID');

    const list = await request.get('/api/payments/methods');
    expect(list.status).toBe(400);
    expect(list.body.error.code).toBe('MISSING_USER_ID');
  });

  it('POST /api/payments/methods/register should reject missing consent', async () => {
    const register = await request
      .post('/api/payments/methods/register')
      .set('X-User-Id', 'user-no-consent')
      .send({
        providerPaymentMethodId: 'pm_mock_card_6666',
        setAsDefault: false,
      });

    expect(register.status).toBe(400);
    expect(register.body.error.code).toBe('VALIDATION_FAILED');
  });
});
