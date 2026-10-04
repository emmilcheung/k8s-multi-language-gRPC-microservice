import { randomUUID } from 'crypto';
import { captureTraceHeaders } from '../../kafka/trace-context';

/** An outbox row carrying a CloudEvents envelope, ready to insert. */
export function buildOutboxRow(topic: string, partitionKey: string, data: Record<string, unknown>) {
  return {
    topic,
    partitionKey,
    traceHeaders: captureTraceHeaders(),
    payload: {
      specversion: '1.0',
      type: topic,
      source: 'payment-service',
      id: randomUUID(),
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data,
    },
  };
}
