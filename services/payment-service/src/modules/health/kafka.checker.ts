import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { buildKafkaClientOptions } from '../../kafka/kafka.config';

@Injectable()
export class KafkaChecker {
  constructor(private readonly config: ConfigService) {}

  async ping(): Promise<void> {
    const admin = new Kafka(buildKafkaClientOptions(this.config, 'payment-service-health')).admin();

    try {
      await admin.connect();
      await admin.fetchTopicMetadata({ topics: [] });
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }
}
