import { ConfigService } from '@nestjs/config';
import { KafkaConfig, SASLOptions } from 'kafkajs';

const TLS_PROTOCOLS = new Set(['SSL', 'SASL_SSL']);
const SASL_PROTOCOLS = new Set(['SASL_PLAINTEXT', 'SASL_SSL']);

type SupportedSaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';

function getKafkaSecurityProtocol(config: ConfigService): string {
  return config.get<string>('KAFKA_SECURITY_PROTOCOL', 'PLAINTEXT').trim().toUpperCase();
}

function getKafkaSaslMechanism(config: ConfigService): SupportedSaslMechanism {
  return config
    .getOrThrow<string>('KAFKA_SASL_MECHANISM')
    .trim()
    .toLowerCase() as SupportedSaslMechanism;
}

function buildKafkaSaslOptions(config: ConfigService): SASLOptions {
  const username = config.getOrThrow<string>('KAFKA_SASL_USERNAME');
  const password = config.getOrThrow<string>('KAFKA_SASL_PASSWORD');

  switch (getKafkaSaslMechanism(config)) {
    case 'plain':
      return { mechanism: 'plain', username, password };
    case 'scram-sha-256':
      return { mechanism: 'scram-sha-256', username, password };
    case 'scram-sha-512':
      return { mechanism: 'scram-sha-512', username, password };
  }
}

export function getKafkaBrokers(config: ConfigService): string[] {
  return config
    .getOrThrow<string>('KAFKA_BROKERS')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

export function getKafkaHostAndPort(config: ConfigService): { host: string; port: number } {
  const [host, portText] = getKafkaBrokers(config)[0].split(':');
  return {
    host,
    port: Number(portText || 9092),
  };
}

export function buildKafkaClientOptions(config: ConfigService, clientId: string): KafkaConfig {
  const securityProtocol = getKafkaSecurityProtocol(config);

  const kafkaConfig: KafkaConfig = {
    clientId,
    brokers: getKafkaBrokers(config),
    connectionTimeout: 3000,
    requestTimeout: 5000,
    retry: { retries: 3, initialRetryTime: 1000 },
  };

  if (TLS_PROTOCOLS.has(securityProtocol)) {
    kafkaConfig.ssl = true;
  }

  if (SASL_PROTOCOLS.has(securityProtocol)) {
    kafkaConfig.sasl = buildKafkaSaslOptions(config);
  }

  return kafkaConfig;
}
