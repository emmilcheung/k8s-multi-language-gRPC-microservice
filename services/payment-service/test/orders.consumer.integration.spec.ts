/**
 * Integration tests for OrdersConsumer with real Kafka + PostgreSQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Logger, LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { Kafka, type Consumer } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';

import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { DatabaseModule } from '../src/database/database.module';
import { PaymentsModule } from '../src/modules/payments/payments.module';
import { HealthModule } from '../src/modules/health/health.module';
import { OrdersConsumer } from '../src/kafka/orders.consumer';
import { STRIPE_CLIENT } from '../src/modules/payments/stripe.constants';

const TOPIC = 'orders.order.created';
const DLQ_TOPIC = `${TOPIC}.dlq`;

let pgContainer: StartedPostgreSqlContainer;
let kafkaContainer: Awaited<ReturnType<GenericContainer['start']>>;
let app: INestApplication;
let pool: Pool;

const mockStripe = {
  paymentIntents: {
    create: ({ metadata }: { metadata: Record<string, string> }) =>
      Promise.resolve({ id: `mock_pi_${metadata.orderId ?? 'unknown'}` }),
  },
};

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('payments_test')
    .withUsername('payments_user')
    .withPassword('payments_pass')
    .start();

  kafkaContainer = await new GenericContainer('apache/kafka:3.7.0')
    .withExposedPorts({ container: 9092, host: 19093 })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:19093',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true',
    })
    .withWaitStrategy(Wait.forLogMessage('Kafka Server started').withStartupTimeout(90_000))
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  const kafkaBroker = 'localhost:19093';

  process.env['DATABASE_URL'] = databaseUrl;
  process.env['STRIPE_SECRET_KEY'] = 'test_mock';
  process.env['KAFKA_BROKERS'] = kafkaBroker;
  process.env['NODE_ENV'] = 'test';

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

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validate: (config: Record<string, unknown>) => {
          const result = z
            .object({
              DATABASE_URL: z.string(),
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
    providers: [OrdersConsumer],
  })
    .overrideProvider(STRIPE_CLIENT)
    .useValue(mockStripe)
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(app.get(Logger)));

  await app.init();

  const kafka = new Kafka({
    clientId: 'payments-consumer-it-admin',
    brokers: [kafkaBroker],
  });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      { topic: TOPIC, numPartitions: 1, replicationFactor: 1 },
      { topic: DLQ_TOPIC, numPartitions: 1, replicationFactor: 1 },
    ],
  });
  await admin.disconnect();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await kafkaContainer?.stop();
  await pgContainer?.stop();
});

beforeEach(async () => {
  await pool.query('DELETE FROM outbox');
  await pool.query('DELETE FROM payments');
});

function buildOrderCreatedEvent(
  overrides: Partial<{ orderId: string; userId: string; amount: number }> = {},
) {
  return {
    specversion: '1.0',
    type: TOPIC,
    source: 'order-service',
    id: randomId(),
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      orderId: overrides.orderId ?? randomId(),
      userId: overrides.userId ?? randomId(),
      amount: overrides.amount ?? 2500,
      currency: 'usd',
    },
  };
}

function randomId(): string {
  return uuidv4();
}

async function publish(topic: string, payload: unknown): Promise<void> {
  const kafka = new Kafka({
    clientId: 'payments-consumer-it-publisher',
    brokers: [process.env['KAFKA_BROKERS']!],
  });
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({ topic, messages: [{ value: JSON.stringify(payload) }] });
  await producer.disconnect();
}

async function consumeOne(topic: string, timeoutMs = 10_000): Promise<string | null> {
  const kafka = new Kafka({
    clientId: 'payments-consumer-it-reader',
    brokers: [process.env['KAFKA_BROKERS']!],
  });
  const consumer: Consumer = kafka.consumer({
    groupId: `payments-consumer-it-${topic}-${Date.now()}`,
  });

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      void consumer.disconnect().catch(() => undefined);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    void consumer
      .run({
        eachMessage: ({ message }) => {
          clearTimeout(timer);
          finish(message.value?.toString() ?? null);
          return Promise.resolve();
        },
      })
      .catch(() => {
        clearTimeout(timer);
        finish(null);
      });
  });
}

async function waitForPayment(orderId: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rowCount } = await pool.query('SELECT 1 FROM payments WHERE order_id = $1', [orderId]);
    if ((rowCount ?? 0) > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

describe('OrdersConsumer integration', () => {
  it('processes orders.order.created and persists payment row', async () => {
    const event = buildOrderCreatedEvent();
    await publish(TOPIC, event);

    const found = await waitForPayment(event.data.orderId);
    expect(found).toBe(true);

    const result = await pool.query(
      'SELECT order_id, user_id, amount, currency, status FROM payments WHERE order_id = $1',
      [event.data.orderId],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      order_id: event.data.orderId,
      user_id: event.data.userId,
      amount: event.data.amount,
      currency: 'usd',
      status: 'completed',
    });
  });

  it('routes invalid payload to DLQ', async () => {
    await publish(TOPIC, { bad: 'payload' });

    const dlqMessage = await consumeOne(DLQ_TOPIC);
    expect(dlqMessage).toBeTruthy();
  });
});
