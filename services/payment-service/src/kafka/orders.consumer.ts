import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Kafka, Consumer, EachMessagePayload, KafkaMessage, Producer } from 'kafkajs';
import * as net from 'net';
import { PaymentsService } from '../modules/payments/payments.service';
import { withKafkaConsumerSpan, withKafkaProducerSpan } from './trace-context';
import { buildKafkaClientOptions, getKafkaHostAndPort } from './kafka.config';

/** Shape of the CloudEvents envelope we expect from order-service. */
interface OrderCreatedEvent {
  specversion: string;
  type: string;
  source: string;
  id: string;
  time: string;
  datacontenttype: string;
  data: {
    orderId: string;
    userId: string;
    amount: number;
    currency?: string;
  };
}

/** Emitted by order-service when a captured payment's order cannot be fulfilled. */
interface OrderUnfulfillableEvent {
  data: {
    orderId: string;
    reason: string;
  };
}

const ORDER_CREATED_TOPIC = 'orders.order.created';
const ORDER_UNFULFILLABLE_TOPIC = 'orders.order.unfulfillable';
const TOPICS = [ORDER_CREATED_TOPIC, ORDER_UNFULFILLABLE_TOPIC];
const MAX_RETRIES = 3;

@Injectable()
export class OrdersConsumer implements OnModuleInit, OnModuleDestroy {
  // Nullable — only set if Kafka broker is reachable at startup.
  private consumer: Consumer | null = null;
  private producer: Producer | null = null;

  constructor(
    @InjectPinoLogger(OrdersConsumer.name)
    private readonly logger: PinoLogger,
    private readonly config: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async onModuleInit() {
    // Pre-flight TCP check — if the broker port is closed, skip Kafka entirely.
    // The Kafka constructor + consumer/producer factory calls must happen AFTER this
    // check because KafkaJS starts background BrokerPool network activity at
    // construction time, which throws an uncatchable error after 5 retries when the
    // broker is permanently unreachable (e.g. local dev with Kafka disabled).
    const brokerReachable = await this.isBrokerReachable();
    if (!brokerReachable) {
      this.logger.warn(
        'Kafka broker unreachable at startup — consumer will not run (acceptable in local dev with Kafka disabled)',
      );
      return;
    }

    const kafka = new Kafka(buildKafkaClientOptions(this.config, 'payment-service'));

    this.consumer = kafka.consumer({ groupId: 'payment-service' });
    this.producer = kafka.producer();

    try {
      await this.producer.connect();
      await this.consumer.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { err: msg },
        'Kafka broker unreachable at startup — consumer will not run (acceptable in local dev with Kafka disabled)',
      );
      return;
    }

    // On a cold-start Kafka the topic may not yet exist. Retry subscription with
    // exponential back-off (max 10 attempts, ~30 s total) rather than crashing.
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await this.consumer.subscribe({ topics: TOPICS, fromBeginning: false });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 10) {
          this.logger.error(
            { err: msg, topics: TOPICS },
            'Kafka subscribe failed after 10 attempts — giving up',
          );
          throw err;
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        this.logger.warn(
          { attempt, topics: TOPICS, err: msg },
          `Kafka subscribe failed — retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    await this.consumer.run({ eachMessage: (payload) => this.handleMessage(payload) });
    this.logger.info({ topics: TOPICS }, 'Kafka consumer started');
  }

  async onModuleDestroy() {
    try {
      await this.consumer?.disconnect();
    } catch {
      /* ignore if never connected */
    }
    try {
      await this.producer?.disconnect();
    } catch {
      /* ignore if never connected */
    }
  }

  /**
   * Attempt a TCP connection to the first Kafka broker. Returns true if reachable,
   * false if the connection is refused or times out within 1 second.
   *
   * This MUST be called before constructing any Kafka/Consumer/Producer objects,
   * because KafkaJS starts background BrokerPool network activity at construction
   * time and throws an uncatchable error after retry exhaustion.
   */
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

  private async handleMessage({ topic, message }: EachMessagePayload): Promise<void> {
    await withKafkaConsumerSpan(`kafka consume ${topic}`, message.headers, async () => {
      const raw = message.value?.toString();
      if (!raw) {
        this.logger.warn('Received empty Kafka message — skipping');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger.error({ topic }, 'Failed to parse Kafka message — routing to DLQ');
        await this.sendToDlq(topic, message, 'PARSE_ERROR');
        return;
      }

      const handle = this.handlerFor(topic, parsed);
      if (!handle) {
        this.logger.error({ topic }, 'Invalid event payload — routing to DLQ');
        await this.sendToDlq(topic, message, 'INVALID_PAYLOAD');
        return;
      }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await handle.run();
          return;
        } catch (err) {
          const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
          const msg = err instanceof Error ? err.message : 'Unknown';
          this.logger.warn(
            { attempt, topic, orderId: handle.orderId, err: msg },
            `Processing failed — retrying in ${delay}ms`,
          );
          if (attempt < MAX_RETRIES) {
            await sleep(delay);
          }
        }
      }

      this.logger.error(
        { topic, orderId: handle.orderId },
        'All retries exhausted — routing to DLQ',
      );
      await this.sendToDlq(topic, message, 'MAX_RETRIES_EXCEEDED');
    });
  }

  /** Validates the payload for its topic; null means it belongs in the DLQ. */
  private handlerFor(
    topic: string,
    parsed: unknown,
  ): { orderId: string; run: () => Promise<void> } | null {
    if (topic === ORDER_UNFULFILLABLE_TOPIC) {
      const data = (parsed as Partial<OrderUnfulfillableEvent> | null)?.data;
      if (!data?.orderId || !data?.reason) return null;
      return {
        orderId: data.orderId,
        run: () => this.paymentsService.processOrderUnfulfillableEvent(data),
      };
    }
    const data = (parsed as Partial<OrderCreatedEvent> | null)?.data;
    if (!data?.orderId || !data?.userId || !data?.amount) return null;
    return {
      orderId: data.orderId,
      run: () => this.paymentsService.processOrderCreatedEvent(data),
    };
  }

  private async sendToDlq(topic: string, message: KafkaMessage, reason: string): Promise<void> {
    if (!this.producer) return; // never connected — nothing to do
    const dlqTopic = `${topic}.dlq`;
    try {
      await withKafkaProducerSpan(`kafka publish ${dlqTopic}`, undefined, async (headers) => {
        await this.producer!.send({
          topic: dlqTopic,
          messages: [
            {
              key: message.key,
              value: message.value,
              headers: { ...message.headers, ...headers, 'x-dlq-reason': reason },
            },
          ],
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      this.logger.error({ err: msg }, 'Failed to send message to DLQ');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
