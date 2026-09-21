import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { OutboxRelayService } from './outbox-relay.service';
import { type DrizzleDB } from '../../database/database.module';

type LoggerMock = Pick<PinoLogger, 'info' | 'warn' | 'error'>;
type ConfigMock = Pick<ConfigService, 'getOrThrow'>;
type DbMock = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  /** Records the lock clause the relay asked for on its claim query. */
  lockArgs: unknown[][];
  /** Ids passed to update(...).set({ published: true }). */
  markedPublished: string[];
};

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeConfig() {
  return {
    getOrThrow: vi.fn().mockReturnValue('localhost:9092'),
  };
}

/**
 * Pulls the bound string value out of a Drizzle condition such as
 * eq(outbox.id, 'outbox-a'), so a test can assert which row was targeted.
 */
function boundStringParam(cond: unknown): string {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const chunk of chunks) {
    const value = (chunk as { value?: unknown })?.value;
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * Minimal Drizzle stand-in. `rows` is what the claim query returns; deleteBatches
 * is the sequence of results the cleanup DELETE yields on successive calls.
 */
function makeDb(rows: Array<Record<string, unknown>>, deleteBatches: string[][] = []) {
  const lockArgs: unknown[][] = [];
  const markedPublished: string[] = [];

  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      for: vi.fn((...args: unknown[]) => {
        lockArgs.push(args);
        return Promise.resolve(rows);
      }),
      // The cleanup subquery is awaited only via inArray(), never on its own,
      // but keep it thenable so a stray await resolves to the claimed rows.
      then: (resolve: (v: unknown) => unknown) => resolve(rows),
    };
    return chain;
  };

  const makeUpdateChain = () => ({
    set: vi.fn().mockReturnThis(),
    where: vi.fn((cond: unknown) => {
      markedPublished.push(boundStringParam(cond));
      return Promise.resolve(undefined);
    }),
  });

  let deleteCall = 0;
  const makeDeleteChain = () => ({
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(() => {
      const batch = deleteBatches[deleteCall] ?? [];
      deleteCall++;
      return Promise.resolve(batch.map((id) => ({ id })));
    }),
  });

  const db: DbMock = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    delete: vi.fn(() => makeDeleteChain()),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        select: db.select,
        update: db.update,
        delete: db.delete,
      });
    }),
    lockArgs,
    markedPublished,
  };
  return db;
}

function createRelayService(params: {
  logger: LoggerMock;
  config: ConfigMock;
  db: DbMock;
}): OutboxRelayService {
  return new OutboxRelayService(
    params.logger as unknown as PinoLogger,
    params.config as unknown as ConfigService,
    params.db as unknown as DrizzleDB,
  );
}

describe('OutboxRelayService.relay', () => {
  let logger: LoggerMock;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('should emit a payment audit event when Kafka publish fails', async () => {
    const db = makeDb([
      {
        id: 'outbox-1',
        topic: 'payments.payment.captured',
        partitionKey: 'order-1',
        payload: {
          type: 'payments.payment.captured',
          data: { orderId: 'order-1', paymentId: 'pay-1' },
        },
        traceHeaders: {},
        createdAt: new Date(),
      },
    ]);

    const service = createRelayService({ logger, config: makeConfig(), db });
    const relayState = service as unknown as Record<string, unknown>;
    relayState['kafkaAvailable'] = true;
    relayState['producer'] = {
      send: vi.fn().mockRejectedValue(new Error('broker unavailable')),
    };

    await service.relay();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.outbox.publish_failed',
        outboxId: 'outbox-1',
        topic: 'payments.payment.captured',
        partitionKey: 'order-1',
        cloudEventType: 'payments.payment.captured',
        errorName: 'Error',
        errorMessage: 'broker unavailable',
      }),
      'Payment audit event',
    );
  });

  // payment-service runs 2–6 replicas. Without SKIP LOCKED every replica selects
  // and publishes the same unpublished rows every second, multiplying Kafka
  // traffic and downstream work by the replica count.
  it('should claim rows with FOR UPDATE SKIP LOCKED so replicas take disjoint slices', async () => {
    const db = makeDb([]);
    const service = createRelayService({ logger, config: makeConfig(), db });
    const relayState = service as unknown as Record<string, unknown>;
    relayState['kafkaAvailable'] = true;
    relayState['producer'] = { send: vi.fn().mockResolvedValue(undefined) };

    await service.relay();

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.lockArgs).toEqual([['update', { skipLocked: true }]]);
  });

  // Claiming the batch in one transaction must not cost us the per-row progress
  // the previous implementation had: rows published before a failure stay marked,
  // so a broker blip does not cause the whole batch to be re-sent next tick.
  it('should keep rows published before a failure marked, and stop at the failing row', async () => {
    const rows = ['a', 'b', 'c'].map((id) => ({
      id: `outbox-${id}`,
      topic: 'payments.payment.captured',
      partitionKey: `order-${id}`,
      payload: { type: 'payments.payment.captured', data: {} },
      traceHeaders: {},
      createdAt: new Date(),
    }));
    const db = makeDb(rows);
    const service = createRelayService({ logger, config: makeConfig(), db });
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined) // outbox-a succeeds
      .mockRejectedValueOnce(new Error('broker unavailable')) // outbox-b fails
      .mockResolvedValue(undefined);
    const relayState = service as unknown as Record<string, unknown>;
    relayState['kafkaAvailable'] = true;
    relayState['producer'] = { send };

    await service.relay();

    expect(send).toHaveBeenCalledTimes(2); // stopped at the failure, did not try outbox-c
    expect(db.markedPublished).toEqual(['outbox-a']);
  });
});

describe('OutboxRelayService.purgePublished', () => {
  let logger: LoggerMock;

  beforeEach(() => {
    logger = makeLogger();
  });

  // Without retention the outbox table grows for the life of the deployment.
  it('should keep deleting while batches come back full', async () => {
    const full = Array.from({ length: 500 }, (_, i) => `row-${i}`);
    const db = makeDb([], [full, full, ['row-last']]);
    const service = createRelayService({ logger, config: makeConfig(), db });

    await service.purgePublished();

    expect(db.delete).toHaveBeenCalledTimes(3); // stops once a batch comes back short
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 1001, retentionHours: 24 }),
      'Outbox cleanup: deleted published rows past retention',
    );
  });

  // A purge failure must not take the relay down with it — the outbox still works,
  // it just has not reclaimed space this cycle.
  it('should warn and not throw when the delete fails', async () => {
    const db = makeDb([]);
    db.delete = vi.fn(() => ({
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockRejectedValue(new Error('deadlock detected')),
    }));
    const service = createRelayService({ logger, config: makeConfig(), db });

    await expect(service.purgePublished()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'deadlock detected' }),
      'Outbox cleanup failed — will retry on next schedule',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
