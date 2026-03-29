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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Logger, LoggerModule } from 'nestjs-pino';
import * as Joi from 'joi';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs';
import * as path from 'path';
import supertest from 'supertest';

import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { DatabaseModule } from '../src/database/database.module';
import { PaymentsModule } from '../src/modules/payments/payments.module';
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

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('payments_test')
    .withUsername('payments_user')
    .withPassword('payments_pass')
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  process.env['DATABASE_URL'] = databaseUrl;
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
  await pool.query(migration1Sql);
  await pool.query(migration2Sql);

  // Bootstrap NestJS without pino pretty and with mocked Stripe + Kafka consumer
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validationSchema: Joi.object({
          DATABASE_URL: Joi.string().required(),
          STRIPE_SECRET_KEY: Joi.string().required(),
          KAFKA_BROKERS: Joi.string().required(),
          NODE_ENV: Joi.string().default('test'),
        }),
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
    .overrideProvider(KafkaChecker)
    .useValue(mockKafkaChecker)
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(Logger)));

  await app.init();
  request = supertest(app.getHttpServer());
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
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/payments returns 201 Created given valid input and X-User-Id header', () => {
  beforeAll(cleanPayments);

  it('should create a payment and return it', async () => {
    const res = await request.post('/api/payments').set('X-User-Id', 'user-integration-1').send({
      orderId: '6e65651c-0424-475c-b491-82bc26e7818a',
      amount: 2000,
      currency: 'usd',
      token: 'pm_test_ok',
    });

    expect(res.status).toBe(201);
    expect(res.body.payment.orderId).toBe('6e65651c-0424-475c-b491-82bc26e7818a');
    expect(res.body.payment.status).toBe('completed');
    expect(res.body.payment.id).toBeDefined();
  });
});

describe('POST /api/payments returns 201 and is idempotent when called twice with same orderId', () => {
  beforeAll(cleanPayments);

  it('should return the same payment on duplicate request', async () => {
    const body = {
      orderId: 'aa7b17d0-398c-4fcb-abe6-9be62cee1769',
      amount: 1500,
      token: 'pm_test_ok',
    };
    const r1 = await request.post('/api/payments').set('X-User-Id', 'user-1').send(body);
    const r2 = await request.post('/api/payments').set('X-User-Id', 'user-1').send(body);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.payment.id).toBe(r2.body.payment.id);
  });
});

describe('POST /api/payments returns 400 when X-User-Id header is missing', () => {
  it('should reject the request without X-User-Id', async () => {
    const res = await request
      .post('/api/payments')
      .send({ orderId: '06750fa4-2de3-4831-8a3d-e8ccf081a168', amount: 500, token: 'pm_x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_USER_ID');
  });
});

describe('POST /api/payments returns 400 given invalid body', () => {
  it('should reject missing amount', async () => {
    const res = await request
      .post('/api/payments')
      .set('X-User-Id', 'user-1')
      .send({ orderId: 'ab0a6bb5-e7f9-4455-b3ea-6e8cf218c526', token: 'pm_x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('should reject a non-UUID orderId', async () => {
    const res = await request
      .post('/api/payments')
      .set('X-User-Id', 'user-1')
      .send({ orderId: 'not-a-uuid', amount: 500, token: 'pm_x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('should reject unknown extra fields', async () => {
    const res = await request.post('/api/payments').set('X-User-Id', 'user-1').send({
      orderId: '0a6a4658-acf6-42a9-936e-5ee155f96418',
      amount: 500,
      token: 'pm_x',
      admin: true,
    });

    expect(res.status).toBe(400);
  });

  it('should reject zero or negative amount', async () => {
    const res = await request
      .post('/api/payments')
      .set('X-User-Id', 'user-1')
      .send({ orderId: 'aa6295a1-8791-4f4c-810d-8c885fdb762e', amount: 0, token: 'pm_x' });

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
      .send({ orderId: 'c238b3f5-5ce7-430f-a4d2-ad8e3a946a4e', amount: 3000, token: 'pm_ok' });
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
