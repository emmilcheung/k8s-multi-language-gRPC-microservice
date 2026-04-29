# Pre-Production Reliability & Observability Readiness

> **For agentic workers:** implement this plan workstream-by-workstream and keep the checkbox state current. Do not mix deployment/CD work into this plan; AWS environment preparation and automated CD remain explicitly out of scope.

**Goal:** close the critical non-deployment gaps identified in the April 2026 SRE review before the platform is treated as ready for real deployment.

**Out of scope:** AWS account/bootstrap work, Kubernetes environment provisioning, GitHub Actions deploy jobs, production secrets management, and any staging/prod rollout automation.

**Architecture:** the platform already has a usable local observability stack (Prometheus, Grafana, OTel Collector, Jaeger), RED dashboards, strong resilience patterns in order-service and ticket-service, and reliable async mechanics in payment-service. This plan targets the remaining critical gaps only: no alerting layer, incomplete edge/service telemetry coverage, and a weak synchronous dependency in payment-service.

**Tech Stack:** Prometheus, Grafana, OTel Collector, Jaeger, Apollo Router, NestJS, TypeScript, Helm

---

## File Map

### Modified
| File | Change |
|---|---|
| `observability/local/prometheus.yml` | Load alert rule groups and add missing scrape targets where applicable |
| `observability/local/otel-collector.yaml` | Add a metrics pipeline for OTLP metrics and expose a Prometheus-exportable path |
| `observability/local/README.md` | Document the updated alerting and investigation workflow |
| `observability/local/grafana/dashboards/platform-overview.json` | Add edge and alert-summary panels |
| `observability/local/grafana/dashboards/services-red.json` | Add service drilldowns for dependency failures and saturation |
| `infra/helm/charts/observability/values.yaml` | Wire alert rules, missing scrape jobs, and collector metrics support into the chart |
| `infra/helm/charts/apollo-router/values.yaml` | Enable router metrics exposure in a way Prometheus can consume |
| `infra/helm/charts/apollo-router/templates/deployment.yaml` | Pass the required telemetry env/config to the router container |
| `infra/helm/charts/apollo-router/templates/service.yaml` | Expose any metrics port or annotations needed for scraping |
| `services/user-service/package.json` | Add the Prometheus dependency used by other Nest services |
| `services/user-service/src/app.module.ts` | Register a metrics module |
| `services/payment-service/src/app.module.ts` | Add config for retry/breaker thresholds on order-service lookups |
| `services/payment-service/src/modules/payments/order-service.client.ts` | Add retry, circuit-breaker, and failure metrics around the outbound order lookup |
| `services/payment-service/src/modules/payments/payments.service.spec.ts` | Cover degraded and retry-exhausted payment lookup behavior |
| `services/payment-service/test/payments.integration.spec.ts` | Cover payment lookup transient failures and final service-unavailable behavior |

### New
| File | Purpose |
|---|---|
| `observability/local/prometheus/rules/platform-alerts.yml` | Core platform alert rules for availability, errors, and latency burn |
| `observability/local/prometheus/rules/async-path-alerts.yml` | Alert rules for Kafka retry/DLQ and payment outbox backlog |
| `infra/helm/charts/observability/templates/configmap-prometheus-rules.yaml` | Mount Prometheus alert rules in Kubernetes |
| `services/user-service/src/modules/metrics/metrics.module.ts` | Prometheus registration and middleware binding |
| `services/user-service/src/modules/metrics/http-red.middleware.ts` | `http_requests_total` and `http_request_duration_seconds` for user-service |
| `services/payment-service/src/modules/payments/order-service.client.spec.ts` | Focused unit tests for retry and circuit-breaker behavior |

---

## Workstream 1: Add active alerting instead of passive dashboards only

**Files:**
- Modify: `observability/local/prometheus.yml`
- Modify: `infra/helm/charts/observability/values.yaml`
- New: `observability/local/prometheus/rules/platform-alerts.yml`
- New: `observability/local/prometheus/rules/async-path-alerts.yml`
- New: `infra/helm/charts/observability/templates/configmap-prometheus-rules.yaml`
- Modify: `observability/local/README.md`

The current stack can be inspected, but it does not actively detect failures. Before real deployment, Prometheus must evaluate rule groups for the platform failure modes that already matter in local and cluster environments.

---

- [x] **Step 1: Mount Prometheus rule files in the local stack**

Update `observability/local/prometheus.yml` to load rule groups from a dedicated rules directory instead of using scrape jobs only.

Add rule loading for:
- service-down detection (`up == 0`)
- elevated 5xx rate by service
- p95 latency burn by service
- missing scrape target health for critical services

- [x] **Step 2: Create platform alert rules**

Create `observability/local/prometheus/rules/platform-alerts.yml` with alerts for:
- `CriticalServiceDown`
- `HighHttp5xxRate`
- `HighRequestLatencyP95`
- `ApolloRouterTelemetryMissing`
- `UserServiceTelemetryMissing`

Each alert should include clear labels and annotations: `severity`, `service`, `summary`, `description`, and a first diagnostic hint.

- [x] **Step 3: Create async-path alert rules**

Create `observability/local/prometheus/rules/async-path-alerts.yml` with alerts for:
- payment outbox publish failures or sustained backlog age
- Kafka DLQ activity for orders/payment flows
- sustained consumer retry or lag conditions where metrics exist

If the required metrics do not exist yet, add a TODO block in the rule file and document the missing instrumentation explicitly rather than inventing fake signals.

- [x] **Step 4: Carry the same alerting model into Helm**

Create `infra/helm/charts/observability/templates/configmap-prometheus-rules.yaml` and update `infra/helm/charts/observability/values.yaml` so the Kubernetes Prometheus instance loads the same rule groups.

Keep the chart value-driven, consistent with the existing Prometheus config pattern.

- [x] **Step 5: Document the operator response loop**

Update `observability/local/README.md` with:
- what alerts exist
- what each alert means
- first PromQL or Grafana checks to run
- when to move from metrics to traces to logs

- [x] **Step 6: Validate alert rule syntax**

Run a focused validation that the Prometheus config still parses and the rule files are mounted correctly.

Suggested checks:

```bash
docker compose -f observability/local/docker-compose.observability.yml config
helm template ticketing ./infra/helm -f ./infra/helm/values-local.yaml
```

**Exit criteria:** Prometheus loads rule groups in both local and Helm-rendered configs, and the repo contains actionable alerts for service health, 5xx, latency, and async-path issues.

---

## Workstream 2: Close telemetry coverage gaps at the edge and on missing services

**Files:**
- Modify: `observability/local/otel-collector.yaml`
- Modify: `observability/local/prometheus.yml`
- Modify: `infra/helm/charts/observability/values.yaml`
- Modify: `infra/helm/charts/apollo-router/values.yaml`
- Modify: `infra/helm/charts/apollo-router/templates/deployment.yaml`
- Modify: `infra/helm/charts/apollo-router/templates/service.yaml`
- Modify: `services/user-service/package.json`
- Modify: `services/user-service/src/app.module.ts`
- New: `services/user-service/src/modules/metrics/metrics.module.ts`
- New: `services/user-service/src/modules/metrics/http-red.middleware.ts`
- Modify: `observability/local/grafana/dashboards/platform-overview.json`
- Modify: `observability/local/grafana/dashboards/services-red.json`

Apollo Router exports OTLP metrics today, but the collector only processes traces. User-service also has no RED metrics module, so it stays outside the standard dashboards. This workstream brings edge and user-facing service telemetry into the same operational views as the rest of the platform.

---

- [x] **Step 1: Add an OTel metrics pipeline to the collector**

Update `observability/local/otel-collector.yaml` and the Helm collector config in `infra/helm/charts/observability/values.yaml` to support OTLP metrics ingestion and Prometheus export or re-exposure.

The target outcome is simple: Apollo Router metrics emitted over OTLP must become queryable in Prometheus and visible in Grafana.

- [x] **Step 2: Expose Apollo Router metrics for scraping or export**

Update the Apollo Router chart so the deployment and service make router metrics available to Prometheus in a stable way.

Prefer the least-complex production shape:
- either direct Prometheus scraping from the router service
- or collector-mediated export if that is already the intended pattern

Do not support both paths unless there is a clear need.

- [x] **Step 3: Add Apollo Router visibility to dashboards**

Update `platform-overview.json` and `services-red.json` with router-focused panels for:
- request rate
- error rate
- p95 latency
- subgraph failure rate or upstream error ratio if the exported metrics support it

- [x] **Step 4: Add a metrics module to user-service**

Mirror the proven Nest pattern already used by payment-service:
- add `@willsoto/nestjs-prometheus` to `services/user-service/package.json`
- create `services/user-service/src/modules/metrics/metrics.module.ts`
- create `services/user-service/src/modules/metrics/http-red.middleware.ts`
- register the module from `services/user-service/src/app.module.ts`

Use the standard metric names and labels from `docs/08-observability.md`:
- `http_requests_total`
- `http_request_duration_seconds`
- labels `service`, `method`, `route`, `status_code`

- [x] **Step 5: Scrape user-service and router metrics in both local and Helm configs**

Update `observability/local/prometheus.yml` and `infra/helm/charts/observability/values.yaml` so user-service and Apollo Router are included in the scrape set.

- [x] **Step 6: Validate telemetry end-to-end**

Run focused checks that:
- user-service exposes `/metrics`
- Prometheus shows healthy scrape targets for user-service and Apollo Router
- Grafana panels populate with non-empty series

Suggested checks:

```bash
pnpm lint && pnpm test && pnpm build
docker compose up -d prometheus grafana otel-collector
curl -fsS http://localhost:3004/metrics
```

**Exit criteria:** Apollo Router and user-service appear in Prometheus target health, Grafana, and standard investigations.

---

## Workstream 3: Harden payment-service outbound order lookups

**Files:**
- Modify: `services/payment-service/src/app.module.ts`
- Modify: `services/payment-service/src/modules/payments/order-service.client.ts`
- New: `services/payment-service/src/modules/payments/order-service.client.spec.ts`
- Modify: `services/payment-service/src/modules/payments/payments.service.spec.ts`
- Modify: `services/payment-service/test/payments.integration.spec.ts`

Payment-service already has reliable async processing, retries, and DLQ handling around Kafka. Its synchronous HTTP lookup to order-service is the exception: it uses only a timeout and a generic failure. This workstream aligns the payment path with the resilience standard already used elsewhere.

---

- [x] **Step 1: Add explicit resilience config**

Extend the payment-service env schema in `src/app.module.ts` with config for:
- max retry attempts
- base retry delay
- circuit-breaker failure threshold
- circuit-breaker reset window

Choose conservative defaults suitable for an internal order lookup. Keep startup fail-loud validation.

- [x] **Step 2: Implement bounded retry with jitter**

Update `order-service.client.ts` so transient failures (timeout, connection errors, 502/503/504) retry with exponential backoff and jitter.

Do not retry:
- 4xx authorization or not-found responses
- schema-validation failures on a successful HTTP response

- [x] **Step 3: Add a circuit breaker and clear fallback behavior**

Wrap the outbound order lookup in a circuit breaker so repeated upstream failures do not keep hammering order-service.

Fallback behavior for an open breaker should remain explicit and safe:
- return `ORDER_LOOKUP_FAILED`
- log at `WARN` for operational failures, `ERROR` for unexpected ones
- emit metrics that show breaker-open and retry-exhausted conditions

- [x] **Step 4: Add focused tests for retry and breaker behavior**

Create `order-service.client.spec.ts` and cover:
- transient failure followed by success
- retry exhaustion
- no retry on 404/403
- breaker opens after configured failure threshold
- breaker half-open or reset behavior if implemented

Extend `payments.service.spec.ts` and `test/payments.integration.spec.ts` only where necessary to prove the payment path surfaces the correct service-unavailable outcome.

- [x] **Step 5: Validate payment-service statics and tests**

Run the service-local validation loop:

```bash
cd services/payment-service
pnpm lint
pnpm test
pnpm build
```

**Exit criteria:** payment-service order lookups are bounded by timeout, retry, and circuit-breaker policy, with tests covering the main degraded-path cases.

---

## Workstream 4: Add operator-first dashboards and investigation workflow

**Files:**
- Modify: `observability/local/grafana/dashboards/platform-overview.json`
- Modify: `observability/local/grafana/dashboards/services-red.json`
- Modify: `observability/local/README.md`
- Modify: `services/client/scripts/generate-observability-report.mjs`

The existing dashboards are good RED baselines, but they are not yet tuned for answering the real ticketing questions operators will ask during incidents. This workstream adds business-path views and a documented investigation sequence.

---

- [x] **Step 1: Add checkout-path and async-path panels**

Extend Grafana with panels for:
- payment creation success/failure rate
- order lookup failure rate from payment-service
- outbox publish backlog or failure count
- Kafka retry/DLQ activity where metrics exist
- router-to-subgraph latency split if available

- [x] **Step 2: Standardize the “what is broken now” dashboard flow**

Update `observability/local/README.md` with a short operator workflow:
1. target health
2. request rate, error rate, latency
3. dependency-specific panels
4. trace lookup in Jaeger
5. logs only after narrowing the scope

- [x] **Step 3: Make the synthetic observability report reflect the new signals**

Update `services/client/scripts/generate-observability-report.mjs` so the generated report checks for the new scrape targets, router metrics, and alert-driving dashboard panels.

- [x] **Step 4: Validate the investigation loop end-to-end**

Use the synthetic flow to generate one known-good transaction and confirm that engineers can answer:
- what is wrong now
- what happened to this request
- whether the issue is ingress, synchronous dependency, or async propagation

**Exit criteria:** the dashboards and docs support first-response investigation without requiring ad hoc PromQL from memory.

---

## Recommended execution order

1. Workstream 1 — alerting first, because passive observability is not enough.
2. Workstream 2 — close Apollo Router and user-service telemetry gaps.
3. Workstream 3 — harden payment-service order lookups.
4. Workstream 4 — upgrade the operator workflow and dashboards once the underlying signals exist.

## Release gate for this plan

Do not mark this plan complete until all of the following are true:

- [x] A critical service outage produces an alert from the repo-managed rules.
- [x] Apollo Router metrics are queryable in Prometheus and visible in Grafana.
- [x] User-service exposes RED metrics and appears in the standard scrape set.
- [x] Payment-service outbound order lookups are covered by timeout, retry, and circuit-breaker controls.
- [x] A synthetic golden flow can be followed through dashboards and traces without blind spots at the application edge.