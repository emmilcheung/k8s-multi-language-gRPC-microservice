# GraphQL Migration Delta Audit — 2026-05-22

- **Branch:** `feat/client-graphql-foundation`
- **HEAD:** `8edd55480ff4b2fbf24f529ae4ec3353126b3342`
- **Delta auditor model:** GPT-5.3-Codex
- **Original verdict:** HOLD (10 defects: 4 P0 / 3 P1 / 1 P2 / 3 RISK)

## Defect Disposition Table

| ID | Classification | Delta status | Commit(s) | Evidence |
|---|---|---|---|---|
| P0-001 router.yaml drift | REAL | **FIXED** (removed unauthorized cookie propagation; smoke still works) | `5f4ad49` | `services/apollo-router/router.yaml`, `/tmp/graphql-delta/d4-step2-currentUser.json`, `/tmp/graphql-delta/d4-smoke.log` |
| P0-002 Node runtime mismatch | ENV | **RE-PROVED on Node 24** | n/a | `/tmp/graphql-delta/env-node24.txt` |
| P0-003 health/status contract | REAL | **FIXED** (Kong admin bind corrected; router probe contract documented as internal healthcheck) | `c968e22` | `docker-compose.yml`, `/tmp/graphql-delta/d4-kong-status.txt`, `/tmp/graphql-delta/d4-router-health-host.code`, `/tmp/graphql-delta/d4-router-health.inspect.json`, `services/client/tests/e2e/graphql-federation.spec.ts` |
| P0-004 deterministic seed | REAL | **FIXED** | `6d327f8` | `services/client/seed/seed-smoke-data.sh`, `docker-compose.yml`, `/tmp/graphql-delta/d4-smoke.log`, `/tmp/graphql-delta/d4-step3-tickets.json` |
| P1-001 secret leakage in log capture | REAL | **FIXED** (CI gate + scrub script; re-grep empty) | `040aa6c` | `audit/scripts/scrub-secrets.sh`, `.github/workflows/ci.yml`, `/tmp/graphql-delta/d6-secret-grep.log` |
| P1-002 Helm latest tags | REAL | **FIXED** | `a760a69` | `infra/helm/values-local.yaml`, `infra/helm/charts/*/values.yaml`, `/tmp/graphql-delta/d8-latest-tag-grep.log` |
| P1-003 ticket-service signature guard bypass | REAL | **FIXED** (shared wrapper + explicit 401 test) | `b4e0672` | `services/ticket-service/cmd/server/main.go`, `services/ticket-service/internal/graphql/auth.go`, `services/ticket-service/internal/graphql/auth_test.go`, `/tmp/graphql-delta/d1-ticket-guard-test.log` |
| P2-001 kubeconform CI step | REAL | **FIXED** | `9838b18` | `.github/workflows/ci.yml`, `/tmp/graphql-delta/d8-helm-kubeconform.log` |
| RISK D1-F1 | RISK | **FIXED via P1-003** | `b4e0672` | Same as P1-003 |
| RISK D7-F1 metrics coverage | RISK | **RE-PROVED on Node 24** | n/a | `/tmp/graphql-delta/d7-metrics-results.log` |
| RISK D9-F1/2 dependency backlog | RISK | **RE-PROVED + TRIAGED (not fully remediated)** | n/a | `/tmp/graphql-delta/d9-*-pnpm-audit.log`, `/tmp/graphql-delta/d9-*-go-mod-updates.log` |
| RISK D10-F1 rollback runbook | RISK | **FIXED** | `8edd554` | `docs/16-session-progress-log.md`, `/tmp/graphql-delta/revert-dry-run.log` |

## Re-verdict by Dimension (D1–D10)

| Dimension | Verdict | Notes |
|---|---|---|
| D1 | PASS | Ticket GraphQL now uses `WrapWithUserIDSignatureValidation`; explicit invalid-signature 401 test added and passing. |
| D2 | PASS | No new migration-scope contract drift introduced beyond audited items; router drift defect resolved. |
| D3 | PASS | Service build/test gates rerun on Node 24 baseline and passing. |
| D4 | **FAIL** | Compose startup + seeded 7-step smoke flow pass, but full `pnpm test:e2e` remains red (`25 failed / 25 passed`) with repeated `event not found` failures in ticketing/attendance flows. |
| D5 | PASS | No additional REST keep-list policy regressions detected; static keeplist Playwright spec passes. |
| D6 | PASS | Fresh compose logs re-grepped with secret patterns: empty result set. |
| D7 | PASS | Per-service metrics endpoints re-probed and returning metric payloads. |
| D8 | PASS | Node-24 CI hand-replay gates green: GraphQL validation, inline gql ban, keeplist test, Helm template + kubeconform, latest-tag grep. |
| D9 | **RISK** | Node package audits still report multiple High vulnerabilities (client/auth/user/payment); Go module updates triaged but not fully remediated in this pass. |
| D10 | PASS | Revert sequence documented and dry-run performed with cleanup sequence. |

## Final Verdict

- **Delta verdict:** **HOLD**
- **Reason:** D4 remains failing at full E2E suite level and D9 still has unresolved High vulnerability backlog.

## Appendix — Proof-of-fix command tails

### D3 (build/test gates, Node 24)

- `cd services/client && pnpm install --frozen-lockfile && pnpm codegen && pnpm lint && pnpm tsc --noEmit && pnpm test`
  - evidence: `/tmp/graphql-delta/d3-client.log`
- `cd services/auth-service && pnpm install --frozen-lockfile && pnpm lint && pnpm tsc --noEmit && pnpm test`
  - evidence: `/tmp/graphql-delta/d3-auth-service.log`
- `cd services/user-service && pnpm install --frozen-lockfile && pnpm lint && pnpm tsc --noEmit && pnpm test`
  - evidence: `/tmp/graphql-delta/d3-user-service.log`
- `cd services/payment-service && pnpm install --frozen-lockfile && pnpm lint && pnpm tsc --noEmit && pnpm test`
  - evidence: `/tmp/graphql-delta/d3-payment-service.log`
- `cd services/order-service && mvn -q test`
  - evidence: `/tmp/graphql-delta/d3-order-service.log`
- `cd services/ticket-service && go test ./...`
  - evidence: `/tmp/graphql-delta/d3-ticket-service.log`
- `cd services/venue-service && go test ./...`
  - evidence: `/tmp/graphql-delta/d3-venue-service.log`
- `cd services/attendance-service && go test ./...`
  - evidence: `/tmp/graphql-delta/d3-attendance-service.log`

### D4 (compose + seeded smoke + E2E)

- `docker compose up -d --build --wait`
  - evidence: `/tmp/graphql-delta/d4-compose-up.log`
- `curl -fsS http://localhost:4000/health` (auditor expectation)  
  - result: not exposed in this repo (connection refused), evidence: `/tmp/graphql-delta/d4-router-health-host.code`
- Router health contract evidence (container healthcheck healthy):
  - evidence: `/tmp/graphql-delta/d4-router-health.inspect.json`
- `curl -fsS http://localhost:8001/status`
  - evidence: `/tmp/graphql-delta/d4-kong-status.txt`
- 7-step seeded smoke flow (signup/currentUser/ticketsConnection/createOrder/createPayment/cancelOrder/orders)
  - evidence: `/tmp/graphql-delta/d4-smoke.log` and `/tmp/graphql-delta/d4-step*.json`
- `cd services/client && pnpm build && pnpm test:e2e`
  - build pass; E2E fail, evidence: `/tmp/graphql-delta/d4-client-build.log`, `/tmp/graphql-delta/d4-client-e2e.log`

### D6 (secret grep)

- `docker compose logs --no-color > /tmp/graphql-delta/d6-compose-logs-raw.log`
- `grep -nE '<secret-patterns>' /tmp/graphql-delta/d6-compose-logs-raw.log`
  - evidence: `/tmp/graphql-delta/d6-secret-grep.log` (empty)

### D8 (CI/k8s)

- Client CI hand-replay (Node 24):
  - `cd services/client && pnpm codegen`
  - `grep -rEn 'gql...|query|mutation|subscription|fragment' lib/ app/`
  - `pnpm exec playwright test tests/e2e/rest-keeplist.spec.ts`
  - evidence: `/tmp/graphql-delta/d8-client-codegen.log`, `/tmp/graphql-delta/d8-inline-gql-grep.log`, `/tmp/graphql-delta/d8-playwright-keeplist.log`
- Helm rendered manifest validation:
  - `helm template infra/helm/charts/<chart> ... | kubeconform -summary -strict` (via `ghcr.io/yannh/kubeconform`)
  - evidence: `/tmp/graphql-delta/d8-helm-kubeconform.log`
- Latest-tag policy:
  - `grep -RE "tag:\\s*latest" infra/helm`
  - evidence: `/tmp/graphql-delta/d8-latest-tag-grep.log` (empty)

### D1/P1-003 evidence

- Wrapper applied to GraphQL handler:
  - `services/ticket-service/cmd/server/main.go`
- Unit test:
  - `go test -v ./internal/graphql -run TestWrapWithUserIDSignatureValidation_InvalidSignatureReturnsUnauthorized`
  - evidence: `/tmp/graphql-delta/d1-ticket-guard-test.log`

### D10 revert drill

- Dry-run sequence:
  - `git checkout -b tmp/revert-drill-20260522`
  - `git revert --no-commit 09bea9e^..cbf61f1`
  - `git restore --staged . && git restore .`
  - evidence: `/tmp/graphql-delta/revert-dry-run.log`

### RISK D7/D9 triage

- D7 per-service metrics: `/tmp/graphql-delta/d7-metrics-results.log`
- D9 package/go triage evidence:
  - `/tmp/graphql-delta/d9-client-pnpm-audit.log`
  - `/tmp/graphql-delta/d9-auth-service-pnpm-audit.log`
  - `/tmp/graphql-delta/d9-user-service-pnpm-audit.log`
  - `/tmp/graphql-delta/d9-payment-service-pnpm-audit.log`
  - `/tmp/graphql-delta/d9-ticket-service-go-mod-updates.log`
  - `/tmp/graphql-delta/d9-venue-service-go-mod-updates.log`
  - `/tmp/graphql-delta/d9-attendance-service-go-mod-updates.log`

## Open questions for owner

1. Should D4 stay as release-blocking while we open a follow-up workstream for the 25 failing ticketing/attendance Playwright cases, or do you want that fixed in this branch before sign-off?
2. For D9, should we scope a dedicated dependency hardening sprint now (High vulns in multiple PNPM services), or accept risk with a dated mitigation plan?
3. Do you want router health to be host-exposed (e.g., publish health port) to align operator runbooks with `curl localhost` checks, or keep container-internal health only?
