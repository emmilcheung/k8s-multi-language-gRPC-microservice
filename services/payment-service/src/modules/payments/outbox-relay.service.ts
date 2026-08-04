import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Inject } from '@nestjs/common';
import { eq, and, lt, asc, inArray } from 'drizzle-orm';
import { Kafka, Producer } from 'kafkajs';
import * as net from 'net';
import { DRIZZLE_DB, type DrizzleDB } from '../../database/database.module';
import { outbox } from '../../database/schema';
import { withKafkaProducerSpan } from '../../kafka/trace-context';
import { buildKafkaClientOptions, getKafkaHostAndPort } from '../../kafka/kafka.config';

const RELAY_BATCH_SIZE = 50;

/**
 * Retention policy for published outbox rows. Matches order-service's
 * OutboxCleanupJob so the two Postgres-backed outboxes behave identically.
 */
const RETENTION_HOURS = 24;
/** Rows deleted per statement — keeps lock hold time and dead-tuple bursts bounded. */
const CLEANUP_BATCH_SIZE = 500;
/** Upper bound on statements per cleanup run, so one run cannot monopolise the DB. */
const CLEANUP_MAX_BATCHES = 20;

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

    const kafka = new Kafka(buildKafkaClientOptions(this.config, 'payment-service-outbox-relay'));

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

  private auditError(event: string, context: Record<string, unknown>): void {
    this.logger.error({ event, ...context }, 'Payment audit event');
  }

  private errorAuditDetails(err: unknown): Record<string, unknown> {
    if (err instanceof Error) {
      return {
        errorName: err.name,
        errorMessage: err.message,
      };
    }

    return { errorMessage: String(err) };
  }

  /**
   * Poll outbox every second. Publishes up to RELAY_BATCH_SIZE unpublished rows per tick.
   *
   * The one-second interval is deliberate and is NOT the same trade-off as
   * order-service's 5s relay. `payments.payment.captured` is consumed by
   * order-service's PaymentEventConsumer, which marks the order COMPLETE — so this
   * delay sits directly on the user-visible "I paid, is my order confirmed?" path,
   * not on a background window like order expiry. The query it issues is backed by
   * the `idx_payment_outbox_unpublished` partial index (published = false), so an
   * idle poll costs an index probe over the backlog, not a scan of the table.
   *
   * Rows are claimed with FOR UPDATE SKIP LOCKED inside a transaction so that the
   * 2–6 replicas this service runs (see infra/helm/charts/payment-service/values.yaml)
   * each take a disjoint slice instead of every replica publishing every row.
   *
   * On a publish failure the loop stops and commits the rows already marked, rather
   * than rolling the whole batch back: the failed row and everything after it stay
   * unpublished and are retried on the next tick. Consumers must still be idempotent
   * (at-least-once), but this avoids needlessly re-publishing rows that already
   * succeeded in this batch.
   *
   * Stopping — rather than skipping the failed row and continuing — is what preserves
   * per-entity ordering: skipping would let a later event for the same partitionKey
   * reach Kafka before an earlier one that is still being retried. The cost is
   * head-of-line blocking if a row can never be published (e.g. payload over the
   * topic's max.message.bytes); that surfaces as a repeating
   * payment.outbox.publish_failed audit event rather than as silent reordering.
   */
  @Cron(CronExpression.EVERY_SECOND)
  async relay() {
    if (!this.kafkaAvailable || !this.producer) return;

    try {
      await this.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(outbox)
          .where(eq(outbox.published, false))
          .orderBy(asc(outbox.createdAt))
          .limit(RELAY_BATCH_SIZE)
          .for('update', { skipLocked: true });

        for (const row of rows) {
          try {
            await withKafkaProducerSpan(
              `kafka publish ${row.topic}`,
              row.traceHeaders,
              async (headers) => {
                await this.producer!.send({
                  topic: row.topic,
                  messages: [
                    {
                      key: row.partitionKey,
                      value: JSON.stringify(row.payload),
                      headers,
                    },
                  ],
                });
              },
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.auditError('payment.outbox.publish_failed', {
              outboxId: row.id,
              topic: row.topic,
              partitionKey: row.partitionKey,
              cloudEventType:
                typeof row.payload === 'object' && row.payload !== null && 'type' in row.payload
                  ? (row.payload.type as string)
                  : undefined,
              ...this.errorAuditDetails(err),
            });
            this.logger.error(
              { outboxId: row.id, topic: row.topic, err: msg },
              'Outbox relay: failed to publish row — will retry on next tick',
            );
            // Stop here and commit the rows already marked. This row stays
            // published = false and is retried on the next tick.
            return;
          }

          // A failure of this update rolls the batch back on purpose: the row was
          // already sent to Kafka, so re-publishing on the next tick (at-least-once)
          // is the safe outcome.
          await tx.update(outbox).set({ published: true }).where(eq(outbox.id, row.id));

          this.logger.info(
            { outboxId: row.id, topic: row.topic, partitionKey: row.partitionKey },
            'Outbox row published to Kafka',
          );
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: msg }, 'Outbox relay: batch failed');
    }
  }

  /**
   * Purge published outbox rows past the retention window (24h), every 10 minutes.
   *
   * Without this the outbox table grows for the life of the deployment: published
   * rows are never needed again for at-least-once delivery, but they keep
   * accumulating in the heap and bloating the table on a high-churn workload.
   * Policy matches order-service's OutboxCleanupJob.
   *
   * Deletes in bounded batches rather than one unbounded DELETE — a single
   * statement over a large backlog would hold locks for the whole scan and
   * produce one huge dead-tuple burst for autovacuum to absorb.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async purgePublished() {
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);
    let deletedTotal = 0;

    try {
      for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch++) {
        const doomed = this.db
          .select({ id: outbox.id })
          .from(outbox)
          .where(and(eq(outbox.published, true), lt(outbox.createdAt, cutoff)))
          .limit(CLEANUP_BATCH_SIZE);

        const deleted = await this.db
          .delete(outbox)
          .where(inArray(outbox.id, doomed))
          .returning({ id: outbox.id });

        deletedTotal += deleted.length;
        if (deleted.length < CLEANUP_BATCH_SIZE) break;
      }

      if (deletedTotal > 0) {
        this.logger.info(
          { deleted: deletedTotal, retentionHours: RETENTION_HOURS },
          'Outbox cleanup: deleted published rows past retention',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // WARN, not ERROR: the outbox is still fully functional, the purge just
      // did not make progress this cycle and will run again in 10 minutes.
      this.logger.warn({ err: msg }, 'Outbox cleanup failed — will retry on next schedule');
    }
  }

  private isBrokerReachable(): Promise<boolean> {
    const { host, port } = getKafkaHostAndPort(this.config);
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
