import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { buildKafkaClientOptions } from './kafka.config';

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue,
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`Missing config: ${key}`);
      }
      return value;
    },
  } as unknown as ConfigService;
}

describe('buildKafkaClientOptions', () => {
  it('builds a plaintext Kafka client by default', () => {
    const options = buildKafkaClientOptions(
      makeConfig({
        KAFKA_BROKERS: 'broker-1:9092,broker-2:9092',
      }),
      'payment-service',
    );

    expect(options.brokers).toEqual(['broker-1:9092', 'broker-2:9092']);
    expect(options.ssl).toBeUndefined();
    expect(options.sasl).toBeUndefined();
  });

  it('builds a SASL/SCRAM Kafka client when configured', () => {
    const options = buildKafkaClientOptions(
      makeConfig({
        KAFKA_BROKERS: 'msk-broker:9094',
        KAFKA_SECURITY_PROTOCOL: 'SASL_SSL',
        KAFKA_SASL_MECHANISM: 'SCRAM-SHA-256',
        KAFKA_SASL_USERNAME: 'payments',
        KAFKA_SASL_PASSWORD: 'secret',
      }),
      'payment-service',
    );

    expect(options.ssl).toBe(true);
    expect(options.sasl).toEqual({
      mechanism: 'scram-sha-256',
      username: 'payments',
      password: 'secret',
    });
  });
});
