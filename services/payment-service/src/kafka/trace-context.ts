import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import type { IHeaders } from 'kafkajs';

type HeaderValue = string | Buffer | Array<string | Buffer> | undefined;
type HeaderCarrier = Record<string, HeaderValue>;

export type TraceHeaders = Record<string, string>;

const kafkaHeaderGetter: TextMapGetter<HeaderCarrier> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    const value = carrier[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      return value
        .map((item) => normalizeHeaderValue(item))
        .filter((item): item is string => item !== undefined);
    }
    return normalizeHeaderValue(value);
  },
};

const kafkaHeaderSetter: TextMapSetter<HeaderCarrier> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

function normalizeHeaderValue(value: string | Buffer | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

export function captureTraceHeaders(parentContext: Context = context.active()): TraceHeaders {
  const carrier: TraceHeaders = {};
  propagation.inject(parentContext, carrier);
  return carrier;
}

export function extractTraceContext(headers?: Record<string, unknown>): Context {
  return propagation.extract(context.active(), (headers ?? {}) as HeaderCarrier, kafkaHeaderGetter);
}

export async function withKafkaConsumerSpan<T>(
  name: string,
  headers: IHeaders | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const parentContext = extractTraceContext(headers as Record<string, unknown> | undefined);
  const span = trace
    .getTracer('payment-service')
    .startSpan(name, { kind: SpanKind.CONSUMER }, parentContext);
  const spanContext = trace.setSpan(parentContext, span);

  try {
    return await context.with(spanContext, callback);
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
}

export async function withKafkaProducerSpan<T>(
  name: string,
  parentHeaders: Record<string, unknown> | undefined,
  callback: (headers: IHeaders) => Promise<T>,
): Promise<T> {
  const parentContext = parentHeaders ? extractTraceContext(parentHeaders) : context.active();
  const span = trace
    .getTracer('payment-service')
    .startSpan(name, { kind: SpanKind.PRODUCER }, parentContext);
  const spanContext = trace.setSpan(parentContext, span);

  try {
    return await context.with(spanContext, async () => {
      const carrier: HeaderCarrier = {};
      propagation.inject(spanContext, carrier, kafkaHeaderSetter);
      return callback(carrier as IHeaders);
    });
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
}
