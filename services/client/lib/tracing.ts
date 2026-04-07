import { context, trace } from "@opentelemetry/api";

export function currentTraceId(): string | null {
  const span = trace.getSpan(context.active());
  return span?.spanContext().traceId ?? null;
}

export function traceHeaders(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (!span) {
    return {};
  }

  const spanContext = span.spanContext();
  if (!spanContext.traceId || !spanContext.spanId) {
    return {};
  }

  return {
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-01`,
  };
}

export function traceResponseHeaders(): Record<string, string> {
  const traceId = currentTraceId();
  return traceId ? { "x-trace-id": traceId } : {};
}
