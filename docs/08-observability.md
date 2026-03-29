# Observability

## Structured Logging

- **Always log as JSON** — never free-form text.
- Every log line must include: `timestamp` (ISO-8601), `level`, `service`, `traceId`, `spanId`, `message`, and any relevant context fields.
- Log levels: `DEBUG` (dev only), `INFO` (normal operation), `WARN` (degraded but not broken), `ERROR` (requires attention), `FATAL` (service cannot continue).
- Never log PII (names, emails, phone numbers, addresses) or secrets. Hash or mask if context is needed.
- Ship logs to a centralised store (e.g. CloudWatch Logs, Datadog, ELK) — do not rely on `kubectl logs` in production.

## Metrics

- Expose a `/metrics` endpoint in Prometheus format (or use the CloudWatch agent for EKS).
- Instrument every service with the **RED method**: Request rate, Error rate, Duration (latency histogram).
- Expose at minimum: `http_requests_total`, `http_request_duration_seconds`, `grpc_server_handled_total`, `kafka_consumer_lag`.
- Use labels consistently: `service`, `method`, `status_code`, `route`.

## Distributed Tracing

- Use **OpenTelemetry (OTel)** SDK in every service — vendor-neutral.
- Propagate trace context via W3C `traceparent` header on HTTP and gRPC metadata on gRPC calls.
- Auto-instrument frameworks where possible (Express, Gin, Spring Boot, Django).
- Export traces to an OTel Collector sidecar, which forwards to your tracing backend (Jaeger, Tempo, AWS X-Ray).
- Every Kafka consumer/producer must propagate trace context through the message headers.

## Health Checks

Every service must expose:

- `GET /healthz/live` — liveness: returns `200` if the process is alive (no external dependency checks).
- `GET /healthz/ready` — readiness: returns `200` only when all dependencies (DB, Kafka, gRPC upstreams) are reachable. Returns `503` otherwise.
- Configure Kubernetes `livenessProbe` and `readinessProbe` against these endpoints.
