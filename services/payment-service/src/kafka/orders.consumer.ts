import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Kafka, Consumer, EachMessagePayload, KafkaMessage } from 'kafkajs';
import { PaymentsService } from '../modules/payments/payments.service';

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
  private consumer: Consumer;
  private producer: ReturnType<InstanceType<typeof Kafka>['producer']>;

  constructor(
    @InjectPinoLogger(OrdersConsumer.name)
    private readonly logger: PinoLogger,
    private readonly config: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {
    const brokers = this.config.getOrThrow<string>('KAFKA_BROKERS').split(',');
    const kafka = new Kafka({
      clientId: 'payment-service',
      brokers,
    });
    this.consumer = kafka.consumer({ groupId: 'payment-service' });
    this.producer = kafka.producer({ idempotent: true });
  }

  async onModuleInit() {
    await this.producer.connect();
    await this.consumer.connect();

    // On a cold-start Kafka the topic may not yet exist. Retry subscription with
    // exponential back-off (max 10 attempts, ~30 s total) rather than crashing.
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await this.consumer.subscribe({ topic: TOPIC, fromBeginning: false });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 10) {
          this.logger.error({ err: msg, topic: TOPIC }, 'Kafka subscribe failed after 10 attempts — giving up');
          throw err;
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        this.logger.warn({ attempt, topic: TOPIC, err: msg }, `Kafka subscribe failed — retrying in ${delay}ms`);
        await sleep(delay);
      }
    }

    await this.consumer.run({ eachMessage: (payload) => this.handleMessage(payload) });
    this.logger.info({ topic: TOPIC }, 'Kafka consumer started');
  }

  async onModuleDestroy() {
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  private async handleMessage({ message }: EachMessagePayload): Promise<void> {
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

    // Retry with exponential back-off (max 3 attempts)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.paymentsService.processOrderCreatedEvent(event.data);
        return; // success
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

    // All retries exhausted → DLQ
    this.logger.error(
      { orderId: event.data.orderId },
      'All retries exhausted — routing to DLQ',
    );
    await this.sendToDlq(message, 'MAX_RETRIES_EXCEEDED');
  }

  private async sendToDlq(message: KafkaMessage, reason: string): Promise<void> {
    try {
      await this.producer.send({
        topic: DLQ_TOPIC,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: { ...message.headers, 'x-dlq-reason': reason },
          },
        ],
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
