import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Inject } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { Kafka, Producer } from 'kafkajs';
import * as net from 'net';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { outbox } from '../../database/schema';

const RELAY_BATCH_SIZE = 50;

/**
 * OutboxRelayService — transactional outbox relay for payment-service.
 *
 * Polls the outbox table every second for unpublished rows, publishes each to
 * Kafka, then marks it published. This provides at-least-once delivery: even if
 * the process crashes between the DB write and the Kafka send, the row remains
 * unpublished and will be retried on the next poll.
 *
 * Implements audit finding C-05: payments.payment.captured is now published to
 * Kafka via the transactional outbox pattern instead of being injected directly
 * by E2E tests.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private producer: Producer | null = null;
  private kafkaAvailable = false;

  constructor(
    @InjectPinoLogger(OutboxRelayService.name)
    private readonly logger: PinoLogger,
    private readonly config: ConfigService,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
  ) {}

  async onModuleInit() {
    const reachable = await this.isBrokerReachable();
    if (!reachable) {
      this.logger.warn(
        'Kafka broker unreachable at startup — outbox relay will not run (acceptable in local dev with Kafka disabled)',
      );
      return;
    }

    const brokers = this.config.getOrThrow<string>('KAFKA_BROKERS').split(',');
    const kafka = new Kafka({
      clientId: 'payment-service-outbox-relay',
      brokers,
      connectionTimeout: 3000,
      requestTimeout: 5000,
    });

    this.producer = kafka.producer({
      // acks: -1 (all) is the KafkaJS default for producers; ensure idempotency
      idempotent: true,
    });

    try {
      await this.producer.connect();
      this.kafkaAvailable = true;
      this.logger.info('Outbox relay Kafka producer connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: msg }, 'Kafka producer connect failed — relay will not run');
    }
  }

  async onModuleDestroy() {
    try {
      await this.producer?.disconnect();
    } catch {
      /* ignore */
    }
  }

  /**
   * Poll outbox every second. Publishes up to RELAY_BATCH_SIZE unpublished rows per tick.
   * Each row is published and marked individually — partial batch success is safe
   * because each row is idempotent (CloudEvents id is a UUID).
   */
  @Cron(CronExpression.EVERY_SECOND)
  async relay() {
    if (!this.kafkaAvailable || !this.producer) return;

    let rows: (typeof outbox.$inferSelect)[];
    try {
      rows = await this.db
        .select()
        .from(outbox)
        .where(eq(outbox.published, false))
        .orderBy(asc(outbox.createdAt))
        .limit(RELAY_BATCH_SIZE);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: msg }, 'Outbox relay: failed to query unpublished rows');
      return;
    }

    for (const row of rows) {
      try {
        await this.producer.send({
          topic: row.topic,
          messages: [
            {
              key: row.partitionKey,
              value: JSON.stringify(row.payload),
            },
          ],
        });

        await this.db.update(outbox).set({ published: true }).where(eq(outbox.id, row.id));

        this.logger.info(
          { outboxId: row.id, topic: row.topic, partitionKey: row.partitionKey },
          'Outbox row published to Kafka',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { outboxId: row.id, topic: row.topic, err: msg },
          'Outbox relay: failed to publish row — will retry on next tick',
        );
        // Leave published = false — relay will retry on next 1-second tick
      }
    }
  }

  private isBrokerReachable(): Promise<boolean> {
    const brokers = this.config.getOrThrow<string>('KAFKA_BROKERS').split(',');
    const [host, portStr] = brokers[0].split(':');
    const port = parseInt(portStr ?? '9092', 10);
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(1000);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
      socket.connect(port, host);
    });
  }
}
