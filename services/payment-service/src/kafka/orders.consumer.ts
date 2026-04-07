import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Kafka, Consumer, EachMessagePayload, KafkaMessage, Producer } from 'kafkajs';
import * as net from 'net';
import { PaymentsService } from '../modules/payments/payments.service';
import { withKafkaConsumerSpan, withKafkaProducerSpan } from './trace-context';

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

const TOPIC = 'orders.order.created';
const DLQ_TOPIC = `${TOPIC}.dlq`;
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

    const brokers = this.config.getOrThrow<string>('KAFKA_BROKERS').split(',');
    const kafka = new Kafka({
      clientId: 'payment-service',
      brokers,
      connectionTimeout: 3000,
      requestTimeout: 5000,
      retry: { retries: 3, initialRetryTime: 1000 },
    });

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
        await this.consumer.subscribe({ topic: TOPIC, fromBeginning: false });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 10) {
          this.logger.error(
            { err: msg, topic: TOPIC },
            'Kafka subscribe failed after 10 attempts — giving up',
          );
          throw err;
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        this.logger.warn(
          { attempt, topic: TOPIC, err: msg },
          `Kafka subscribe failed — retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    await this.consumer.run({ eachMessage: (payload) => this.handleMessage(payload) });
    this.logger.info({ topic: TOPIC }, 'Kafka consumer started');
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

  private async handleMessage({ topic, message }: EachMessagePayload): Promise<void> {
    await withKafkaConsumerSpan(`kafka consume ${topic}`, message.headers, async () => {
      const raw = message.value?.toString();
      if (!raw) {
        this.logger.warn('Received empty Kafka message — skipping');
        return;
      }

      let event: OrderCreatedEvent;
      try {
        event = JSON.parse(raw) as OrderCreatedEvent;
      } catch {
        this.logger.error({ raw }, 'Failed to parse Kafka message — routing to DLQ');
        await this.sendToDlq(message, 'PARSE_ERROR');
        return;
      }

      if (!event.data?.orderId || !event.data?.userId || !event.data?.amount) {
        this.logger.error({ event }, 'Invalid event payload — routing to DLQ');
        await this.sendToDlq(message, 'INVALID_PAYLOAD');
        return;
      }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.paymentsService.processOrderCreatedEvent(event.data);
          return;
        } catch (err) {
          const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
          const msg = err instanceof Error ? err.message : 'Unknown';
          this.logger.warn(
            { attempt, orderId: event.data.orderId, err: msg },
            `Processing failed — retrying in ${delay}ms`,
          );
          if (attempt < MAX_RETRIES) {
            await sleep(delay);
          }
        }
      }

      this.logger.error({ orderId: event.data.orderId }, 'All retries exhausted — routing to DLQ');
      await this.sendToDlq(message, 'MAX_RETRIES_EXCEEDED');
    });
  }

  private async sendToDlq(message: KafkaMessage, reason: string): Promise<void> {
    if (!this.producer) return; // never connected — nothing to do
    try {
      await withKafkaProducerSpan(`kafka publish ${DLQ_TOPIC}`, undefined, async (headers) => {
        await this.producer!.send({
          topic: DLQ_TOPIC,
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
