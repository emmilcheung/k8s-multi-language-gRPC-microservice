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
| Grafana | Metrics dashboards | `http://localhost:3005` |
| Jaeger | Trace search and span waterfall UI | `http://localhost:16686` |

## Start

```bash
docker compose up --build
```

The Compose file now starts Jaeger, the OTel Collector, Prometheus, and Grafana
alongside the existing application services.

## Verify connectivity

1. Open `http://localhost:9090/targets` and confirm all application jobs are `UP`.
2. Open `http://localhost:9090/alerts` and confirm the platform rule groups load successfully.
3. Open `http://localhost:3005` and sign in with `admin` / `admin`.
4. Open the `Local Platform Overview` and `Services — RED Metrics` dashboards under the `Local Observability` folder.
5. Open `http://localhost:16686/search` and confirm Jaeger is reachable.

## First-response workflow

Use the same operator sequence every time so investigation starts with the highest-signal surfaces.

1. Check target health first in Prometheus `/targets` and resolve any `DOWN` job before reading deeper graphs.
2. Check request rate, error rate, and latency in Grafana starting with `Local Platform Overview`, then pivot to `Services — RED Metrics`.
3. Check dependency-specific panels next:
  - `Payment Create Success Rate` / `Payment Create Failure Rate`
  - `Payment Lookup Failures (5m)` / `Payment Lookup Breaker`
  - `Apollo Router Request Rate` / `Apollo Router Query Planning p95`
4. Check Jaeger traces after narrowing the problem surface to confirm whether the break is ingress, a synchronous dependency hop, or async propagation.
5. Check service logs only after the target, RED, and trace views tell you which service and time window matter.

## Alert rules

Prometheus now evaluates repo-managed rule files from `observability/local/prometheus/`.

Current rule coverage:

- `platform-alerts.yml` for critical service-down detection, OTel Collector availability, sustained 5xx rate, and sustained p95 latency.
- `async-path-alerts.yml` is mounted but intentionally empty today because the repo does not yet expose stable Prometheus metrics for outbox backlog, DLQ volume, retry exhaustion, or Kafka lag.

Use the Prometheus Alerts page first, then pivot into Grafana or Jaeger:

1. If `CriticalServiceDown` fires, verify the failing target in `/targets`, then check the service health endpoint and container status.
2. If `HighHttp5xxRate` fires, open the `Services RED` dashboard and inspect `Top Error Routes` for the affected service.
3. If `HighRequestLatencyP95` fires, start with the p95 latency panels, then inspect event loop lag, goroutines, and Jaeger trace waterfalls.
4. If `OtelCollectorDown` fires, expect trace gaps in Jaeger until the collector is healthy again.

## Known async blind spots

The dashboards can now answer ingress and synchronous dependency questions, but they still do not expose stable Prometheus signals for:

- outbox backlog age or unpublished-row count
- DLQ publish totals
- consumer retry exhaustion totals
- Kafka consumer lag

Until those metrics exist, use the generated order and payment traces in Jaeger to determine whether async propagation continued across Kafka or stopped after the originating HTTP request.

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

- If Jaeger shows Apollo Router traces under `unknown_service:router`, the local
  Compose service is missing an explicit OTEL resource name. Set
  `OTEL_SERVICE_NAME=apollo-router` on the `apollo-router` service in
  `docker-compose.yml` and restart that container. Historical Jaeger entries
  under `unknown_service:router` will remain until they age out.
- Logs remain stdout-first in this phase. Trace IDs in structured logs should
  match the trace IDs visible in Jaeger.
- Prometheus alert rules are now part of the local stack, but notification routing
  is still out of scope in this environment. Use the Prometheus Alerts UI as the
  evaluation surface until a notifier is introduced.
- Grafana currently visualizes metrics only. Trace exploration stays in Jaeger.
- The local OTel Collector is trace-focused. Prometheus continues scraping
  service metrics directly, and the Java agent disables OTEL log and metric
  export in Compose to avoid `UNIMPLEMENTED` exporter noise.
- Kong currently contributes metrics and correlation IDs in the local stack. It
  is not yet configured to emit trace spans to Jaeger.
- Order and payment outbox relays now persist trace headers with each outbox row
  so delayed publishes continue the original trace instead of starting a new one.
- The same OTLP boundary is intended to be reused later for AMP/AMG/X-Ray in AWS.
