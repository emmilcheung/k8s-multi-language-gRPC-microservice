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

function makeDb(rows: Array<Record<string, unknown>>) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };

  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue(updateChain),
  };
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
});
