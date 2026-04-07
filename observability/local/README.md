# Local Observability

This stack adds local trace and metrics visualization for Docker Compose without
changing application instrumentation. Services continue exporting OpenTelemetry
data to an OTel Collector and Prometheus scrapes their existing metrics
endpoints directly.

## Components

| Component | Purpose | URL |
| --- | --- | --- |
| OTel Collector | OTLP ingest + exporter boundary | `http://localhost:4318` / `grpc://localhost:4317` |
| Prometheus | Metrics scraping and query UI | `http://localhost:9090` |
| Grafana | Metrics dashboards | `http://localhost:3004` |
| Jaeger | Trace search and span waterfall UI | `http://localhost:16686` |

## Start

```bash
docker compose up --build
```

The Compose file now starts Jaeger, the OTel Collector, Prometheus, and Grafana
alongside the existing application services.

## Verify connectivity

1. Open `http://localhost:9090/targets` and confirm all application jobs are `UP`.
2. Open `http://localhost:3004` and sign in with `admin` / `admin`.
3. Open the `Local Platform Overview` dashboard under the `Local Observability` folder.
4. Open `http://localhost:16686/search` and confirm Jaeger is reachable.

## Trace a real request path

The fastest path is to run the client on the host and point it at the local
collector so the browser-facing server spans join the backend traces.

```bash
cd services/client
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
OTEL_SERVICE_NAME=client \
pnpm dev --port 4000
```

Then use the application through Kong at `http://localhost:8000`:

1. Sign up or sign in.
2. Create a ticket.
3. Open the ticket and create an order.
4. Complete the stub payment flow.

After that, inspect Jaeger:

1. Search by service name, starting with `order-service`, `payment-service`, or `auth-service`.
2. Narrow the lookback window to the last 15 minutes.
3. Open the trace and verify the span tree crosses the target service and any downstream gRPC spans.

## Validate async traces

For Kafka-backed flows, use the same order creation and payment flow, then check
that the trace continues across producer and consumer spans instead of stopping
at the originating HTTP request.

Look for spans created by:

- `order-service` producing order events
- `payment-service` consuming order events and producing payment events
- `ticket-service` consuming order completion or cancellation events
- `expiration-service` consuming order events for delayed processing and later publishing `expiration.order.expiration_complete`

The expected result now is one shared trace ID across those Kafka hops.

For the expiration path, the trace may stay open longer because the delayed task
restores the original context before publishing the expiration-complete event.
In Jaeger, confirm the later expiration span still belongs to the same trace.

If those spans appear as separate traces, treat that as a regression in async
context propagation.

## Failure-path check

To confirm local startup does not hard-depend on the collector, stop the
collector and restart a Go service or Nest service. The service should still
boot and continue operating, but new spans will no longer be exported until the
collector is available again.

## Notes

- Logs remain stdout-first in this phase. Trace IDs in structured logs should
  match the trace IDs visible in Jaeger.
- Grafana currently visualizes metrics only. Trace exploration stays in Jaeger.
- The local OTel Collector is trace-focused. Prometheus continues scraping
  service metrics directly, and the Java agent disables OTEL log and metric
  export in Compose to avoid `UNIMPLEMENTED` exporter noise.
- Kong currently contributes metrics and correlation IDs in the local stack. It
  is not yet configured to emit trace spans to Jaeger.
- Order and payment outbox relays now persist trace headers with each outbox row
  so delayed publishes continue the original trace instead of starting a new one.
- The same OTLP boundary is intended to be reused later for AMP/AMG/X-Ray in AWS.
