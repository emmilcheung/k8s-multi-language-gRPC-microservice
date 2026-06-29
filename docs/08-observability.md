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

### Soft-dependency exceptions to the readiness rule

**OpenSearch** is a soft dependency of ticket-service. It is opt-in (`SEARCH_BACKEND=opensearch`), and the service automatically falls back to the Mongo query path if OpenSearch is unavailable or not configured. Therefore:

- `/healthz/ready` does **not** check OpenSearch reachability. A cluster where OpenSearch is down or absent still serves all traffic correctly via the Mongo fallback.
- Operators can monitor OpenSearch availability separately via its own `/_cluster/health` endpoint (exposed on port 9200 by the `opensearch` Helm subchart).

## Search Metrics (ticket-service)

The following Prometheus metrics are always registered at startup (present in `/metrics` regardless of `SEARCH_BACKEND`). They are only actively observed when `SEARCH_BACKEND=opensearch`.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `search_query_duration_seconds` | Histogram | `backend=opensearch\|mongo` | End-to-end latency of a ticket search query per backend. Recorded per backend; NOT observed for requests that fully fall back to Mongo (the fallback path returns before the OpenSearch-duration observation point). |
| `search_fallback_total` | Counter | — | Total times an OpenSearch failure caused a fallback to the Mongo path. |
| `search_indexer_lag_seconds` | Histogram | — | Lag between a ticket event's `createdAt` and when the indexer processes it. |
| `search_refill_iterations` | Histogram | — | Number of refill-loop iterations per `TicketsConnection` resolver call. |
| `reindex_progress` | Gauge | — | Documents upserted so far in the current `Reindex` run. |
