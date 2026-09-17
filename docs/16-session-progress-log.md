# Session Progress Log

> Append a new entry each session. Newest entry at the top.
> **Archive policy:** keep the current quarter hot. Move older quarters to `log/archive/<YYYY>-Q<N>.md` at the start of each new quarter. Last archived on **2026-04-17** (2026 Q1 → [`log/archive/2026-Q1.md`](log/archive/2026-Q1.md)).

## Archive index

- [`log/archive/2026-Q1.md`](log/archive/2026-Q1.md) — 2026 Q1 (Jan–Mar) sessions: Kong sandbox fix, CSRF fix, setup.sh hardening, Terraform scaffolding, Kong JWT forwarding + E2E suite.

---

## Session: 2026-09-17 — fix(order): outbox cleanup batching + M1 branch audit ⏳ AUDITED, NOT MERGED

**Branch:** `feat/scalability-m1` (integration) ← `fix/scale-b8-outbox-cleanup-batching`

Fourth and final orchestrated wave for M1, plus the overall review and audit the owner asked for before anything reaches `main`.

### What was done

- **Outbox cleanup batching (SR-06, second half).** `OutboxCleanupJob.purgePublished()` issued one unbounded `DELETE` inside one transaction. Over a backlog — the state left by any Kafka outage — that holds row locks and pins the vacuum horizon for the whole run, and on timeout it makes *no* progress, so the next run retries the same doomed statement forever. It now deletes `outbox.cleanup.batch-size` rows (default 500) per iteration, up to `outbox.cleanup.max-batches` (default 100) per invocation, leaving the remainder to the next schedule.
- **`@Transactional` moved off the job and onto the repository method.** This is the whole point of the change: on `OutboxRepository.deletePublishedBatch` each batch commits on its own, so a failure part-way keeps the progress already made. On the job it would wrap every batch in one outer transaction and roll all of them back — the exact behaviour being removed.
- **`V6__add_outbox_published_index.sql`.** The cleanup `DELETE` had no usable index. `V1`'s `idx_outbox_unpublished` is partial on `WHERE published = false`, which is the *relay's* filter. Without the mirror-image index on `(created_at) WHERE published = true`, batching would have turned one sequential scan into one scan per batch — strictly worse than the unbounded delete it replaces. Plain `CREATE INDEX`, not `CONCURRENTLY`, because Flyway wraps each migration in a transaction and `CONCURRENTLY` cannot run inside one.
- **A false RED recipe corrected.** `OutboxRelayConcurrencyTest.java:106` told a reviewer to swap the claim call to `findUnpublished()` to reproduce the red — but the same SR-06 change deleted that method. Repointed at the `LIMIT … FOR UPDATE SKIP LOCKED` clause that actually has to be removed. Comment only.

### Verification

- Full `mvn test` on the merged tree: **61 tests, 0 failures, 0 errors, 0 skipped, EXIT=0**, with the exit code captured directly rather than through a pipe.
- **Both reds reproduced here, not taken on report.** Dropping the `LIMIT` from `deletePublishedBatch` fails `deletePublishedBatchRespectsItsLimit` (`expected: 100 but was: 250`) *and* `eachBatchCommitsSoAFailurePartWayKeepsItsProgress` (`expected: 50L but was: 0L`) — the worker had reported only the first. Adding `@Transactional` back to `purgePublished()` fails `cleanupJobMustNotBeTransactional` (`expected: null but was: @Transactional(...)`). Both files restored and confirmed byte-identical to `53f84a4`.
- Branch audit: 24 changed files, all traceable to a register item; no secret values; no dependency manifest, migration outside `V6`, client, supergraph, port, NetworkPolicy or securityContext change; every code change merged `--no-ff` from its own `fix/scale-*` branch.
- **A2 backward compatibility verified rather than assumed.** Disabling the in-cluster Postgres/Mongo/Redis subcharts in staging and prod breaks no service because no chart template references those values — services read connection strings from a Kubernetes Secret via `envFrom.secretRef`.

### A sanity check that could not fail — this time the manager's

The ticket specified: "restore `@Transactional` on `purgePublished()` → test C must fail." It cannot. The test constructs the job with `new`, and a hand-constructed object has no Spring AOP proxy, so `@Transactional` on it is completely inert. Confirmed by running it: with the annotation restored, the behavioural test still passes.

This was caught before the worker committed, and fixed by adding `cleanupJobMustNotBeTransactional` — a reflection guard that asserts the annotation is absent and carries the reason in its failure message. It is the property that matters, because in production the job *is* a Spring bean and the annotation *would* take effect there.

That makes four defects of the same shape across this milestone — a check written so that it cannot fail — three from workers and two now from the manager's own tickets. The pattern is specific enough to name: **whenever a fix is verified by reverting it, the revert must be executed, not predicted, and the revert must be shown to produce a failure the test is actually capable of reporting.**

### A bug chased and cleared

`OutboxMessagePublisher.publishOne` carries `@Transactional` with `REQUIRED` propagation and, since SR-06, joins the relay's claim transaction. If a Kafka failure escaped it, the transaction proxy would call `setRollbackOnly()` and the relay's commit would throw `UnexpectedRollbackException`, discarding every mark-published in the batch and re-sending all of them on the next tick — a duplicate storm from a single bad row. It does not happen: the `catch` sits inside the method body, so nothing propagates through the proxy. Recorded because the failure mode is non-obvious and the next person to touch that method needs to know why the `catch` cannot be moved out.

### A conflict between the plan and the register

Plan item `B3` asks for advisory-lock leader election on "venue sweeper **and order cleanup**"; SR-15's register row names only the venue sweeper and the ticket reconciler. Order-service's `OutboxCleanupJob` does run on every pod every 10 minutes, so the plan is not wrong to mention it.

**Dropped deliberately rather than deferred**, because the two designs are mutually exclusive. A per-batch advisory lock does not serialize the job — another pod simply interleaves batches, and each batch is independently correct. A job-wide lock requires one transaction spanning every batch, which is precisely what this change exists to eliminate. Concurrent cleanup pods produce brief lock waits and `deleted = 0`, not incorrectness, on a table bounded by the 24-hour retention the job itself enforces.

### Branch cleanup — the rejected SR-35 attempt was deleted

`fix/scale-b6b-venue-provision-advisory-lock` (`5dc169f4`) was `B6b`'s rejected first attempt: it held `pg_advisory_xact_lock` on a dedicated transaction while still inserting through `r.pool`, so every caller needed two pooled connections and four concurrent provisions exhausted the pool unconditionally, with no lock contention required.

It never merged, so none of its code was ever on this branch and SR-35's status rests solely on `fix/scale-b6b2-venue-provision-tx`. But it was ambiguous at a glance — **two branches carrying `SR-35` in their subject and touching the same two files**, with nothing in either name marking one as superseded, and it was the only unmerged branch of the eight. Deleted on owner instruction, which supersedes the earlier standing "keep the small branch for record" for this branch only. It was never pushed, so `docs/scalability-review.md` now carries its full SHA and the reason it failed as the only remaining record. Seven `fix/scale-*` branches remain, all merged.

### Not done

- **`main` is untouched at `f565089`, and stays that way pending owner approval.** No auto-merge (CLAUDE.md core rule 6).
- M1's exit criterion is not code and cannot be met from here: "every service at 3 replicas in staging for 24h with no duplicate events and no stuck reservations" needs a staging deploy, which is an owner action.
- SR-01 remains half-complete by design: the Helm half landed, the Terraform half (RDS for venue/user/attendance, managed Mongo) is untouched, and `terraform apply` is an owner action under `docs/15-agent-hard-stops.md`.
- Every register item stays `in-progress` rather than `done`; the done-count moves only after merge to `main`.

---

## Session: 2026-09-17 — fix(scale): sweeper leader election, expiration replicas, outbox claim contract ⏳ INTEGRATED, NOT MERGED

**Branch:** `feat/scalability-m1` (integration) ← `fix/scale-b5-expiration-replicas`, `fix/scale-b3a-venue-sweeper-leader`

Third orchestrated wave. Two workers, one manager-written change, and one more worker report that did not survive independent verification — this time not a vacuous test, but a **red that could not have been produced by the test that was committed**.

### What was done

- **Venue hold sweeper leader election (SR-15, first half).** `SweepExpiredHolds` used to run its full-table `UPDATE seats ... WHERE status='HELD' AND held_until < now()` on every replica every 30 seconds. It now opens a transaction, takes `pg_try_advisory_xact_lock(hashtext('venue-hold-sweeper'))`, and returns `(0, nil)` without sweeping when another pod already holds it. The **transaction-scoped** variant is required rather than the session-scoped `pg_try_advisory_lock` the review originally suggested: a session lock would be released back into the pgxpool connection still held, and would then permanently disable the sweeper on that pod. The only caller is the 30s ticker in `internal/hold/sweeper.go`, so no request path can observe the non-leader no-op.
- **expiration-service replicas (SR-08).** `values.yaml` now sets `replicaCount: 2`, and so does the subchart default. A single replica behind a PDB with `minAvailable: 1` can never be evicted, so it was both a SPOF and a permanent blocker for node drains. `values-local.yaml` already pinned 1 and still does, so local is unchanged. No code change was needed: the asynq workers dedupe on `TaskID(orderID)`.
- **Outbox relay claim contract (`docs/04-asynchronous-messaging.md`).** Three services claim outbox rows with `FOR UPDATE SKIP LOCKED` and one uses a Mongo `claimToken`/`leaseUntil` lease, but the standard said only that "a relay process publishes to Kafka" — nothing required a claim at all, so a relay written to that spec would publish every event once per replica. The new section states the contract, both mechanisms, why per-batch commit is accepted rather than fixed, and the test trap below.

### Verification

- **The sweeper red was reproduced here, not taken on report.** With `section_repo.go` reverted to `9bc7357`, the new test fails in 6.5s at `hold_sweeper_leader_test.go:124` — `expected: 0, actual: 3`, "a non-leader pod must not sweep while another pod holds the leader lock". Restored, `go build ./...`, `go vet ./...` and the full `go test ./...` all exit 0, and the working tree is byte-identical to the commit.
- The test simulates the other pod with a session-scoped `pg_advisory_lock` on a second pooled connection. That works because session and transaction advisory locks share one lock space — a session lock taken by the test genuinely blocks the production code's `pg_try_advisory_xact_lock`.
- **All three Helm overlays render on the merged tree**, exit 0 with zero stderr: expiration-service is 1 replica locally and 2 in staging and prod, PDB `minAvailable: 1` throughout, and wave 2's externalization still holds at 0 StatefulSets in staging and prod against 8 locally.
- `git diff --name-only main..feat/scalability-m1` is 18 files. `main` remains untouched at `f565089`.

### A red that never happened

The sweeper worker reported a textbook sanity check: revert the fix, watch the assertion fail with `expected: 0 / actual: 3`. Reverting it here produced something else — the test hung and died on Go's 10-minute default timeout, and the string `actual` appeared **zero times** in the output. The cause was in the test, not the fix: it acquired the simulated-leader connection with `pool.Acquire` and released it only at step 4, so when `require.Equal` called `FailNow` at step 2 the release was skipped and the deferred `pool.Close()` blocked forever on the outstanding connection.

So the assertion was right, the production code was right, and the test still could not report its own failure — it could only hang for ten minutes with no diagnostic. It was rejected and reissued for a `defer leaderConn.Release()`; the red now lands in 6.5 seconds with the message attached. The lesson is narrower than wave 2's but worth the same weight: **a sanity check verifies the test's failure path as much as the fix**, and a quoted red is not evidence unless the failure path can actually print it.

### Not done

- Nothing else from M1's dispatched work is outstanding. SR-15 is now complete on the branch: the ticket-service quota reconciler takes a Redis `SET NX` lease at `ticket-service:reconciler:leader` with TTL = the 5-minute interval, so one replica per tick paginates Mongo and rewrites Redis instead of all of them. It is deliberately not released on success, because releasing it would let the next replica's offset ticker start a second redundant pass inside the same interval; a failed pass does release it. Verified by deleting the election guard and watching both assertions fail, then re-running the full `go test ./...` — including the 201-second testcontainers package the worker stopped short of.
- The order-service outbox cleanup `DELETE` batching split out of SR-06 is still open.
- Nothing has merged to `main`. The overall review and audit of `feat/scalability-m1` is still pending.

---

## Session: 2026-09-16 — fix(scale): prod/staging externalization, outbox SKIP LOCKED, single-transaction venue provisioning ⏳ INTEGRATED, NOT MERGED

**Branch:** `feat/scalability-m1` (integration) ← `fix/scale-a2-overlay-disable-backing-services`, `fix/scale-b6b2-venue-provision-tx`, `fix/scale-b2-payment-outbox-skip-locked`

Second orchestrated wave. Same division of labour as wave 1 — workers implement, the manager verifies every claim independently — and this wave is the case for that division: **two of three workers reported success on tests that could not fail.** Both were caught, reworked and re-verified, and one of the two defective tests was caused by a defective ticket, which is recorded below rather than quietly fixed.

### What was done

- **Prod and staging externalization** — `values-prod.yaml` and `values-staging.yaml` now set `enabled: false` on all eight Bitnami database subcharts. Wave 1 added the toggles; until now nothing exercised them, so the overlays still stood up in-cluster Postgres/Mongo/Redis in both environments.
- **Single-transaction venue provisioning** — `ProvisionFromVenue` runs the advisory lock, the idempotency `COUNT`, the template fetch and the whole clone loop on one `pgx.Tx`, committing at the end. This closes two separate defects with one change: the check-then-act race between concurrent provisions, and the half-built plan that a mid-loop failure used to leave committed, which the `COUNT` guard then read as "already provisioned" forever.
- **payment-service outbox claim** — the relay now runs inside `db.transaction`, claims rows with `.for('update', { skipLocked: true })` and marks them published on that same transaction, so concurrent replicas cannot publish the same outbox row twice. Its test was rejected twice before landing (see below).
- **Interface preserved** — threading the transaction went through an unexported `querier` (`QueryRow` + `SendBatch` + `Query`, satisfied by both `*pgxpool.Pool` and `pgx.Tx`) plus free functions, matching the pattern already used at `section_repo.go:275,345`. The exported `CreateSection`/`BulkInsertSeats` signatures are unchanged, so the six existing stub implementations across the handler, gRPC and GraphQL tests needed no edit.

### Verification

- **The venue deadlock was reproduced before the fix was accepted.** With the test pool pinned to 4 connections, reverting the two inserts to `r.pool` fails all 8 concurrent provisions with `context deadline exceeded` and 0 sections created, after the full 30s timeout; restoring the transaction passes in 1.4s. The production file was confirmed byte-identical afterwards.
- venue-service `go build ./...`, `go vet ./...` and the full `go test ./...` are green on the merged tree, against real PostgreSQL via Testcontainers.
- Prod renders exit 0, zero stderr, **0 StatefulSets**, and **0 references to the `ticketing-postgres-users` Secret**. Staging 0 StatefulSets; local unchanged at exit 0 / 8 StatefulSets.
- **The payment double-publish bug was also reproduced before acceptance.** With `.for('update', { skipLocked: true })` removed from the service, the integration suite exits 1 and relay B claims all 3 rows relay A is holding (`expected 3 to be +0`); restored, exit 0, and the production file is byte-identical. payment-service lint, `tsc --noEmit`, 92 unit tests and 21 integration tests all exit 0 on the merged tree.
- `git diff --name-only main..feat/scalability-m1` is exactly the 15 intended files, no strays. `main` remains at `f565089`.

### Two tests that could not fail

The payment-service relay test never imported, constructed or called `OutboxRelayService` — it opened its own pg client and re-implemented the relay's query in raw SQL, so it verified PostgreSQL's `SKIP LOCKED` rather than ours. The worker's own sanity check demonstrated exactly that and misread it as success: deleting `SKIP LOCKED` from the production service left all 21 tests green, reported as "ALL STEPS PASSED". It was reissued to drive two real relay instances concurrently, with relay A holding its transaction open inside a fake producer, and to require an observed red.

### A defective ticket, and what it cost

The provisioning fix was rejected once and reworked; the rework's mandatory sanity check then **failed to reproduce the bug**, because the ticket told the worker to use pgxpool's default pool size. The default is `max(4, numCPU)`, so on this 10-core machine the pool held 10 connections and the 8 concurrent callers could never exhaust it. The worker honestly reported that reverting the fix still passed — and then asserted the fix was correct anyway, predicting the failure "would manifest on a 4-core system". That prediction was not accepted as verification.

The instrument was fixed rather than the claim believed: `MaxConns` is now pinned explicitly to 4 via `pgxpool.ParseConfig`, which is host-independent and equal to the pool a small production pod actually gets, since `cmd/server/main.go:79` calls `pgxpool.New` with no override. **A concurrency test that takes its pool size from the host cannot be a regression guard** — that is the reusable lesson here.

### Not done

- **New Helm finding, filed not fixed.** `global.imageRegistry` points at a first-party registry, and the Bitnami subcharts honour that global, so they resolve images it does not host; Bitnami redis's `NOTES.txt` guard catches the substitution and aborts the *entire* `helm template` run. `helm template .` with no overlay exits 1, and so did `main`'s prod overlay — `values-local.yaml` renders only because it resets the global to `""`. Prod and staging render after this wave solely because the affected subcharts are now switched off; the misconfiguration itself is untouched and returns the moment anyone re-enables one or writes a new overlay from the defaults.

## Session: 2026-09-16 — fix(scale): helm subchart toggles + outbox SKIP LOCKED claim ⏳ INTEGRATED, NOT MERGED

**Branch:** `feat/scalability-m1` (integration) ← `fix/sr-01-helm-conditions`, `fix/sr-06-order-outbox-claim`

First wave of a scalability remediation effort, run orchestrated: workers implemented, the manager verified every claim independently. Tracked against a local (untracked) review register as items SR-01 and SR-06.

### What was done

- **Helm subchart toggles** — `condition:` added to all eight Bitnami backing subcharts in `infra/helm/Chart.yaml` (postgres-auth/orders/payments/venue/attendance/users, mongodb, redis), with matching `enabled: true` defaults in `values.yaml`. This is the portability contract: overlays disable in-cluster backing stores by toggle rather than by deleting dependencies, which is the precondition for pointing prod at managed databases.
- **order-service outbox claim** — `OutboxRepository.findUnpublished()` replaced with a native `SELECT ... ORDER BY created_at ASC LIMIT :limit FOR UPDATE SKIP LOCKED` (JPQL cannot express `SKIP LOCKED`). `OutboxRelay.relay()` is now `@Transactional`, with batch size from `OUTBOX_RELAY_BATCH_SIZE` (default 100). Previously every replica read every unpublished row with no limit and no lock — N× duplicate publishes, and an unbounded heap load after a Kafka outage.
- **New test** — `OutboxRelayConcurrencyTest` runs two genuinely overlapping transactions (the second `PROPAGATION_REQUIRES_NEW` while the first is still uncommitted) against real PostgreSQL via Testcontainers, and asserts the two claims are disjoint. `@DataJpaTest` is not on this project's classpath, so the JPA slice is wired by hand via `@ImportAutoConfiguration` rather than adding a Maven dependency.

### Verification

- All three Helm overlays render at exit 0 with zero stderr: local 187343 B / 8 StatefulSets, staging and prod 213207 B / 7 StatefulSets each. Local is byte-identical to the pre-change baseline; staging/prod differ only in Bitnami's per-render random `postgres-password`.
- order-service: **57 tests, 0 failures, 0 errors, 0 skipped**, read directly from `target/surefire-reports/*.txt` — a piped `mvn | tail` reports tail's exit status, not Maven's. `mvn checkstyle:check` exit 0.
- Red→green reproduced independently of the worker: the committed test, run against pre-change `main` with its claim pointed back at the old `findUnpublished()`, fails on the disjointness assertion; on the branch it passes.
- `git diff --name-only main..feat/scalability-m1` is exactly the 7 intended files.

### Known tradeoff (affects future outbox work)

Mark-published now commits **per batch**, not per message. Failure containment regressed — one failing row can poison the shared persistence context for the rest of the batch — and the claim transaction holds row locks across up to 100 blocking Kafka sends. Consumers must be idempotent (AGENTS.md §3.5).

**Decided: accept, and copy this pattern to other relays rather than "fixing" it.** Per-message commit is structurally incompatible with holding a `FOR UPDATE SKIP LOCKED` claim open — an inner `REQUIRES_NEW` transaction updating a row the outer transaction has locked blocks on the outer, while the outer synchronously waits for that inner call to return. Postgres cannot detect this (it sees only the inner session waiting on the outer's lock), so it stalls to `lock_timeout` rather than aborting. Per-message commit therefore means abandoning `SKIP LOCKED` for claim-by-`UPDATE`, costing a migration plus a lease column and a stuck-claim reaper — speculative complexity (Rule 2) with no measured need. Revisit on evidence: an observed duplicate-publish rate or a long-transaction alert. Batch size is env-tunable in the meantime.

### Not done

- Outbox cleanup `DELETE` batching — part of the same register item, split to its own ticket.
- A third task (venue-service lock ordering) was **stopped and reverted, not shipped**: the suspected deadlock did not reproduce in 90+ runs across three configurations, and all three `FOR UPDATE` sites use a single-statement `WHERE id = ANY($1)`, which locks in scan order rather than caller-supplied order, making lock-order inversion structurally impossible. Shipping a test that passes both before and after would have been a false green. **Since closed as deferred** — a defensive `ORDER BY s.id` would be a change no test can fail on (Rule 9), and in Postgres an `ORDER BY` above a `FOR UPDATE` does not reliably dictate lock acquisition order anyway. Reopen only if a real SQLSTATE 40P01 is observed on a venue seat path.
- **Not merged to `main`** (CLAUDE.md core rule 6). `main` is unmoved at `f565089`.

### Integration audit

Audited before proceeding. The diff is clean, and one real gap was found and closed: the Helm work had only been verified on the `enabled: true` path — that everything still rendered unchanged — while the actual point of the ticket, that `enabled: false` *removes* a subchart, was never exercised. Now tested: prod rendered with `postgres-venue`, `postgres-attendance` and `redis` off gives exit 0, zero stderr, 213207→172261 bytes, StatefulSets 7→4, and zero occurrences of all three release names. A suspected second gap (that the `kafka` dependency carried no `condition:`) was **wrong** — it does, as do `cp-kafka`, `opensearch` and `observability`; only `kong` and the first-party service subcharts lack toggles, which is out of scope here.

### Follow-up found while verifying

The prod render emits Secret `ticketing-postgres-users` with a literal password that is **regenerated on every render**, so a real `helm upgrade` would rotate the password out from under the running database and the StatefulSet would fail to authenticate. `infra/helm/templates/` contains no `kind: Secret`, so every other `existingSecret` reference is provisioned out-of-band — `postgres-users` is the one block that never got the same treatment. Now tracked as its own P0 register item. It stays open rather than being fixed inline: the remedy depends on where the credential should come from (out-of-band `existingSecret` like the other five, or External Secrets/SSM), which is an infrastructure choice, not a mechanical edit.

---

## Session: 2026-06-24 — feat(search): metrics, opt-in OpenSearch Helm subchart, docs ✅ COMPLETE

**Branch:** `feat/opensearch-ticket-search`

### What was done

Completed Task 8 (rollout hardening) of the OpenSearch search feature in ticket-service.

#### Summary

- **New dependency:** `github.com/prometheus/client_golang v1.23.2` promoted from indirect to direct in `go.mod` (already present as a transitive dep of `echo-contrib`).
- **New search dependency (Tasks 1–7):** `github.com/opensearch-project/opensearch-go/v4 v4.6.0` — added in earlier tasks; no new deps added this session.
- **New package:** `internal/metrics/` — `SearchMetrics` struct with five Prometheus instruments registered on a caller-supplied registry (testable without the global default).
- **Metric wiring:**
  - `search_query_duration_seconds{backend}`: observed on the OpenSearch path (wraps entire refill loop) and the Mongo fallback path in `schema.resolvers.go`.
  - `search_fallback_total`: incremented in the `TicketsConnection` resolver when an OpenSearch error triggers the Mongo fallback.
  - `search_refill_iterations`: observed at the end of each resolver refill loop.
  - `search_indexer_lag_seconds`: observed in `search.Indexer.processWithRetry` after a successful decode, measuring `now - event.CreatedAt`.
  - `reindex_progress`: set as a gauge in `search.Reindex` after each page is upserted.
- **Helm subchart:** `infra/helm/charts/opensearch/` — single-node Deployment (`discovery.type=single-node`, `DISABLE_SECURITY_PLUGIN=true`, 512Mi req / 1Gi limit), ClusterIP Service on 9200. Declared in umbrella `Chart.yaml` with `condition: opensearch.enabled`. Disabled locally (`values-local.yaml`), documented in `values.yaml`.
- **Docs:** `docs/08-observability.md` (soft-dep exception + search metrics table), `README.md` (port 9200 + `docker compose --profile search`).
- **Test:** `TestSearchMetrics_Registered` in `internal/metrics/search_test.go` — no external deps, verifies all five instruments register and Counter increments correctly.

#### Commits on this branch (this session)

| Commit | Scope | Summary |
|---|---|---|
| `60962ec` | feat(search) | search metrics, opt-in opensearch helm subchart, docs |

---

## Session: 2026-05-22 — runbook(graphql): add explicit migration revert sequence ✅ COMPLETE

**Branch:** `feat/client-graphql-foundation`

### Rollback command sequence (dry-run ready)

Use a throwaway branch, then run the migration-range revert exactly in this order:

```bash
git checkout -b chore/graphql-revert-dry-run
git revert --no-commit 09bea9e^..cbf61f1
```

If the dry-run is only for rehearsing rollback mechanics, discard local changes:

```bash
git restore --staged .
git restore .
```

### Post-revert smoke check

After a real revert commit, run:

```bash
docker compose up -d --build --wait
curl -fsS http://localhost:8000/healthz/live
curl -fsS http://localhost:8001/status
```

Expected: compose healthy, gateway liveness 200, Kong status 200.

---

## Session: 2026-05-22 — feat(client): complete GraphQL Phase 4 migration ✅ COMPLETE

**Branch:** `feat/client-graphql-foundation`

### What was done

Completed the full GraphQL-first migration for the `services/client` Next.js app across Phases 4.1–4.7 plus cleanup (Stage 5).

#### Commits on this branch (newest first)

| Commit | Scope | Summary |
|---|---|---|
| Stage 5 | cleanup | Narrow `lib/api.ts`; add AGENTS.md data-fetching section; update docs |
| `4430489` | Phase 4.6 | Browser urql seat selection (HoldSeats, ReleaseSeats, 5s polling) |
| `fd2ed10` | Phase 4.7 | Attendance + scan pages → GraphQL |
| `9391482` | Phase 4.4 | Payment-method registration milestone |
| `e2baa49` | Phase 4.3 | Orders, cancel, payment → GraphQL |
| `3ebf238` | Phase 4.2 | Ticket browse + detail → GraphQL |
| `12a13ca` | Phase 4.1 | Settings page → GraphQL |
| `25c0a42` | infra | Apollo Router cookie propagation + attendance routing |

#### Key outcomes

- All app screens now use `executeQuery` / `executeMutation` from `lib/graphql/execute.ts` (server) or urql hooks (browser, seat map only).
- `lib/api.ts` narrowed to `serverApi` + `ApiError`; all domain REST wrappers removed.
- REST keep-list documented in `services/client/AGENTS.md §Data Fetching`.
- Schema gaps (SeatingPlan.name, AvailabilitySnapshot.counts) kept as REST; reasons documented.
- Hard stops 11–12 added to `docs/15-agent-hard-stops.md`: no SDL copying into client, no inline gql strings.
- `docs/03-api-design.md` updated with Phase 4 migration outcome.

### Verification (pre-commit)

| Check | Result |
|---|---|
| `pnpm tsc --noEmit` | ✅ 0 errors |
| `pnpm lint` | ✅ clean |
| `pnpm test` | ✅ 143/143 |
| Inline-gql grep | ✅ OK (0 matches) |
| REST keeplist grep | ✅ OK (0 violations) |

---

## Session: 2026-05-07 — docs(qr-attendance): register repo-grounded superpowers plan ✅ COMPLETE

**Branch:** `main`

### What was done

Registered a new superpowers-compatible implementation plan for QR-code attendance that is grounded in the current microservices repo instead of the earlier generic enterprise assumptions, then updated the API standard to reflect the repository's GraphQL-plus-REST model.

1. **`docs/superpowers/plans/2026-05-07-qr-attendance.md`** — added a continuation-friendly execution plan in the same style as the existing superpowers plans.
   The plan is explicitly scoped to the current platform and distinguishes:
   - net-new `attendance-service`
   - targeted modifications to `client`, `kong-gateway`, Helm, and only minimal existing backend surfaces
   - deferred email delivery because the repo does not currently contain a notification/email service

2. Enriched the same attendance plan with explicit implementation recommendations and a required test plan so future agent sessions do not skip the service-boundary, protocol-split, security, or regression requirements.

3. **`docs/03-api-design.md`** — updated the API standard so REST and GraphQL are both documented as first-class external API styles with different target consumers:
   - GraphQL for app-facing composed client flows
   - REST + OpenAPI for third-party integrations, MCP/agent tooling, and command-style operational endpoints

4. The plan is intentionally structured for follow-up agent sessions:
   - goal / out-of-scope / architecture / tech stack
   - explicit file map
   - checkbox workstreams
   - recommended execution order
   - release gate

5. No application code was changed in this session.

### Outcome

The repository now contains a superpowers-compatible QR attendance plan plus an updated API standard, so future agentic implementation work can follow the intended GraphQL/REST split, test strategy, and service-boundary decisions without re-deriving them from chat history.

---

## Session: 2026-04-30 — ops(observability): rehearse CriticalServiceDown alert ✅ COMPLETE

**Branch:** `feat/observability-release-gate`

### What was done

Finished the last remaining release-gate step for the pre-production observability plan.

1. Created a dedicated branch, `feat/observability-release-gate`, from the current working tree so the final validation work is isolated from `main`.
2. Performed a controlled local outage by stopping `user-service`, which is one of the critical scrape targets covered by the repo-managed `CriticalServiceDown` rule.
3. Verified Prometheus transitioned the target to `up=0` and fired `CriticalServiceDown` for `job="user-service"`.
4. Restored `user-service` with Docker Compose and verified Prometheus returned the target to `health: up` and cleared the alert.

### Verification

- `curl http://localhost:9090/api/v1/query?query=up{job="user-service"}` before outage returned `1` ✅
- `curl http://localhost:9090/api/v1/query?query=ALERTS{alertname="CriticalServiceDown"}` before outage returned no active alert ✅
- `docker compose stop user-service` triggered a real local scrape failure ✅
- Prometheus query for `ALERTS{alertname="CriticalServiceDown",alertstate="firing",job="user-service"}` returned a firing alert with `severity="critical"` ✅
- Prometheus query for `up{job="user-service"}` during outage returned `0` ✅
- `docker compose up -d user-service` restored the service ✅
- Post-recovery Prometheus queries showed `up{job="user-service"} == 1` and no remaining `CriticalServiceDown` alert for `user-service` ✅

### Outcome

The final release gate is now closed: the repository does not just define alert rules, it has a verified local rehearsal showing that a real critical scrape outage produces the expected repo-managed alert and clears again after recovery.

---

## Session: 2026-04-30 — feat(observability): wire alerts, telemetry coverage, and payment lookup resilience ✅ COMPLETE

**Branch:** `main`

### What was done

Implemented the critical pre-production observability and reliability backlog, excluding deployment/CD work.

1. **Alerting and Prometheus rule wiring**
- Added repo-managed Prometheus rule loading for the local stack and Helm chart.
- Added core platform alerts for service-down, 5xx, and latency conditions plus an async-path placeholder rule file that explicitly documents missing backlog and DLQ instrumentation.
- Updated the local observability README with the alert response loop and initial operator workflow.

2. **Apollo Router and user-service telemetry coverage**
- Added an OTel Collector metrics pipeline with a Prometheus exporter so Apollo Router OTLP metrics become queryable in Prometheus.
- Added user-service RED metrics via a Nest Prometheus module and middleware pattern aligned with the existing platform metric names.
- Updated Prometheus scrape configuration in local and Helm values to include Apollo Router and user-service.
- Repaired and extended the Grafana dashboards so platform and RED views now include Apollo Router request rate, error rate, and p95 latency panels.

3. **Payment-service synchronous dependency hardening**
- Hardened `OrderServiceClient` with timeout-aware retry, exponential backoff with jitter, an in-process circuit breaker, and Prometheus metrics for failures, retries, and breaker-open state.
- Added focused unit coverage for retry and breaker behavior and added a degraded-path integration assertion that returns 503 when order lookup is unavailable.
- Documented the new resilience configuration in the payment-service README and example env file.

4. **Operator-first dashboards and investigation workflow**
- Extended the local Grafana dashboards with payment-path panels for create success/failure rate, lookup failures, retries, and circuit-breaker state, while keeping Apollo Router panels aligned to the collector-exported metric names.
- Updated the local observability README with a fixed first-response workflow: targets first, then RED, then dependency-specific panels, then Jaeger, then logs.
- Updated the synthetic observability report to use the corrected Grafana port, verify both provisioned dashboards, sample payment and router Prometheus signals, capture refreshed screenshots, and assert async propagation from Kafka publish/process trace evidence.
- Refreshed `observability/local/docs/observability-report.json` and `observability/local/docs/observability-report.md` from a passing end-to-end run.

### Verification

- `docker compose -f observability/local/docker-compose.observability.yml config --services` ✅
- `helm template observability ./infra/helm/charts/observability` ✅
- `node -e "JSON.parse(require('fs').readFileSync('observability/local/grafana/dashboards/platform-overview.json','utf8'))"` ✅
- `node -e "JSON.parse(require('fs').readFileSync('observability/local/grafana/dashboards/services-red.json','utf8'))"` ✅
- `pnpm tsc --noEmit` in `services/user-service` ✅
- `curl -i http://localhost:3004/metrics` after rebuilding `services/user-service` ✅
- `curl http://localhost:9090/api/v1/targets` showed `apollo-router` and `user-service` scrape targets `up` ✅
- `curl -u admin:admin http://localhost:3005/api/search` confirmed Grafana dashboard provisioning on the corrected host port ✅
- `curl http://localhost:9090/api/v1/query?query=sum(rate(apollo_router_operations_total[5m]))` returned router traffic ✅
- `curl http://localhost:9090/api/v1/query?query=histogram_quantile(0.95,sum(apollo_router_query_planning_total_duration_bucket) by (le))` returned router planning latency ✅
- `pnpm test:observability-report` in `services/client` ✅
- `pnpm lint && pnpm tsc --noEmit` in `services/client` ✅
- `pnpm vitest run src/modules/payments/order-service.client.spec.ts` in `services/payment-service` ✅
- `pnpm vitest run --config vitest.integration.config.ts test/payments.integration.spec.ts --testNamePattern "order lookup is unavailable"` in `services/payment-service` ✅
- `pnpm tsc --noEmit` in `services/payment-service` ✅
- `pnpm build` in `services/payment-service` ✅

### Outcome

- The repository now has active alert evaluation, broader edge and service telemetry coverage, repaired operator dashboards, and a hardened synchronous payment lookup path.
- Follow-up fixes discovered during live validation are now included too: the local Grafana host port no longer collides with `user-service`, `user-service` exposes `/metrics` via an explicit controller, the Apollo Router dashboard queries now match the actual exported metric names, and the synthetic observability report now proves dashboard availability, payment-path metrics, router metrics, and Kafka async trace continuity from a passing golden flow.

---

## Session: 2026-04-30 — docs(interview): add backend interview knowledge graph and pressure-question bank ✅ COMPLETE

**Branch:** `main`

### What was done

Created a living interview-prep document that turns the purchase-flow architecture into a reusable knowledge graph plus question bank for senior backend interviews.

1. **`docs/interview.md`** — added a durable interview-prep document.
It includes a Mermaid knowledge graph, core invariants, senior-level pressure questions, direct repository evidence, and a discovery backlog for later expansion.

2. Expanded the same document with a dedicated payment-system deep-dive layer:
It now includes a second Mermaid graph focused on charge initiation, webhook races, outbox semantics, payment-domain gaps, and a concrete hardening path toward more payment-company-grade capabilities such as refunds, reconciliation, processed-event ledgers, and richer lifecycle modeling.

3. **`AGENTS.md`** — added the new document to the documentation index so it can be loaded on demand in future sessions.

4. No application code changes were made in this session.

### Outcome

The repository now contains a persistent interview-prep knowledge base that can be incrementally extended as new questions, failure modes, and design trade-offs are discovered.

---

## Session: 2026-04-30 — docs(reliability): add pre-production observability and resilience backlog ✅ COMPLETE

**Branch:** `main`

### What was done

Created a concrete pre-production readiness backlog focused only on the critical non-deployment gaps that should be closed before real deployment.

1. **`docs/superpowers/plans/2026-04-30-preprod-reliability-observability.md`** — added a dated implementation plan covering four workstreams:
  - active alerting and Prometheus rule groups
  - Apollo Router and user-service telemetry coverage
  - payment-service order lookup resilience hardening
  - operator-first dashboards and investigation workflow

2. Explicitly scoped out AWS environment preparation, deploy automation, and other CD concerns so the plan stays actionable even while client infrastructure is not ready.

3. No application code changes were made in this session.

### Outcome

The repository now contains a concrete backlog for the critical observability and reliability work that should be completed before the platform is treated as deployment-ready.

---

## Session: 2026-04-23 — docs(graphql-federation): document order-service Spring GraphQL deviation ✅ COMPLETE

**Branch:** `feature/graphql-federation`

### What was done

Updated spec and plan docs to reflect the actual implementation of the order-service GraphQL subgraph.

1. **`docs/superpowers/specs/2026-04-20-graphql-federation-design.md`** — replaced all Netflix DGS references in order-service context with Spring GraphQL; updated the architecture diagram label, subgraph assignments table, implementation pattern section (dependencies, file structure), DataLoader table, and rollout step 4; added a rationale note: order-service uses Spring GraphQL (`@Controller` + `@QueryMapping`/`@SchemaMapping`) instead of Netflix DGS — Spring-native, zero additional dependency, sufficient for federation via `@apollographql/federation-jvm`.

2. **`docs/superpowers/plans/2026-04-20-graphql-federation.md`** — updated Tech Stack line (Netflix DGS → Spring GraphQL), added a one-line deviation note pointing to the spec, updated File Map table (DGS-named files → actual Spring GraphQL filenames), updated Task 16 title and pom.xml dependency block, updated Task 17 title, test class, and implementation code to reflect `@Controller`-based approach.

3. No code changes were made.

### Outcome

Spec and plan now accurately reflect the implemented Spring GraphQL approach. Rationale is captured in the spec. No functional changes.

---

## Session: 2026-04-15 — Settings release hardening + clean bootstrap gate ✅ COMPLETE

**Branch:** `main`

### What was done

1. **User-service startup path hardened**
- Added a runtime SQL migration runner for `services/user-service` that applies `migrations/*.sql` in sorted order and records filename checksums in `schema_migrations`.
- Kept fail-loud startup behavior so checksum drift or SQL failures stop the container before Nest starts.
- Preserved schema-aware readiness and startup verification for `user_profiles`, `user_preferences`, and `billing_addresses`.

2. **Payment-service startup path hardened**
- Replaced the metadata-dependent runtime migrator with the same explicit SQL migration runner strategy in `services/payment-service`.
- Ensured clean boot now creates the saved-payment schema required by readiness: `payment_customers` and `saved_payment_methods`.
- Kept `/healthz/ready` as the compose health target so missing schema fails fast.

3. **Production-parity validation retained and extended**
- `pnpm migrate` in both TypeScript services now uses the same code path as container startup instead of a separate `drizzle-kit migrate` path.
- Client settings action unit coverage remained in place for session-auth routing.
- Existing settings Playwright coverage was rerun against the rebuilt stack.

4. **Clean environment proof completed**
- Rebuilt the full stack from empty volumes with `docker compose down -v && docker compose up --build --detach`.
- Verified both `payment-service` and `user-service` passed readiness from the fresh bootstrap.
- Ran the settings-focused Playwright flow successfully against the clean stack.

### Verification

- `pnpm lint && pnpm build` in `services/payment-service` ✅
- `pnpm lint && pnpm build` in `services/user-service` ✅
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:1/<db> pnpm migrate` in both services reached the new migration entrypoint and failed only on the expected connection refusal ✅
- `docker compose down -v && docker compose up --build --detach` from repo root ✅
- `curl -fsS http://localhost:3002/healthz/ready` ✅
- `curl -fsS http://localhost:3004/healthz/ready` ✅
- `pnpm exec playwright test tests/e2e/ticketing.spec.ts --grep settings` in `services/client` ✅ (3/3 passed)

### Outcome

- The settings release-hardening path now proves the audit requirement that a fresh local bootstrap does not require manual SQL.
- The clean-stack verification for saved payment methods and session/settings flows is passing end to end.

---

## Session: 2026-04-09 — Linkerd gRPC transport hardening + ticket outbox relay tests ✅ COMPLETE

**Branch:** `copilot/worktree-2026-04-08T16-22-48`

### What was done

1. **Ticket-service outbox relay test coverage added**
- Added focused package tests in `services/ticket-service/internal/outbox/relay_test.go`.
- Covered publish routing, success ack flow, failed publish requeue flow, payload mapping, and retry backoff capping.
- Refactored `internal/outbox/relay.go` to depend on narrow repo/producer interfaces so the relay is directly testable without concrete Mongo/Kafka implementations.

2. **Mongo-backed outbox integration tests added**
- Added `services/ticket-service/test/outbox_relay_integration_test.go` using the existing Testcontainers Mongo fixture.
- Covered claim leasing, ack removal, requeue state updates, expired-lease reclaim, and wrong-token rejection.

3. **Internal gRPC transport moved onto a Linkerd mesh story in Kubernetes**
- Added global Helm values for service-mesh configuration in `infra/helm/values.yaml` and `infra/helm/values-local.yaml`.
- Injected the gRPC participants into Linkerd via pod annotations in:
   - `infra/helm/charts/ticket-service/templates/deployment.yaml`
   - `infra/helm/charts/venue-service/templates/deployment.yaml`
   - `infra/helm/charts/order-service/templates/deployment.yaml`
- Added port-scoped Linkerd `Server` + `ServerAuthorization` resources for the ticket-service and venue-service gRPC ports so HTTP ingress via Kong is not blocked.

4. **Local Kubernetes bootstrap updated**
- `infra/local/setup.sh` now requires the `linkerd` CLI and installs or upgrades the Linkerd control plane before Helm deploy.
- Existing Kafka skip-port behavior remains in place for Linkerd.

### Verification

- `go test ./internal/outbox ./test -run 'Outbox|Relay|Claim|Acknowledge|Requeue'` in `services/ticket-service` ✅
- `go test ./... && go vet ./...` in `services/ticket-service` ✅
- `helm dependency build ./infra/helm` ✅
- `helm template ticketing ./infra/helm -f ./infra/helm/values-local.yaml` ✅

### Follow-up

- A full local Kubernetes run of `./infra/local/setup.sh` was not executed in this session, so live cluster verification of Linkerd-enforced traffic remains the next operational check.

---

## Session: 2026-04-01 — Quota & Seating Plan Design: Open Questions Resolved ✅ READY FOR IMPLEMENTATION

**Branch:** N/A (design documents only)

### What was done

1. **Comprehensive codebase exploration** of all 5 existing services — architecture, models, handlers, Kafka events, gRPC, database schemas.

2. **GA Quota Design Document** written at `docs/quota-reservation-design.md`:
   - 9 sections covering model changes, Redis Lua scripts, phased implementation (11 phases), breaking changes, migration strategy, 30+ unit tests, 5 load test scenarios, risk analysis.

3. **Venue Seating Plan Design Document** written at `docs/venue-seating-plan-design.md`:
   - 20 sections covering new venue-service architecture, seat state machine, hold mechanism (Redis Lua scripts), reservation flows (4 flows), auto-assign algorithm, SSE real-time, cross-service integration, order model changes, PostgreSQL schema, gRPC proto definitions, template system, 14 implementation phases.

4. **All critical open questions resolved** via stakeholder Q&A:

| Decision | Resolution |
|---|---|
| Sold counter | Option A: Separate `sold` field. `available = quota - reserved - sold`. |
| Multi-quantity V1 | Yes — support from V1. `CreateOrderRequest.quantity` defaults to 1. |
| Redisson lock | Keep as fallback safety net with reduced TTL (2s). Primary atomicity from Lua scripts. |
| `orders.order.completed` topic | Add new Kafka topic. Producer: order-service. Consumers: venue-service + ticket-service. |

5. **Both design documents updated** with all resolved decisions:
   - Status changed from DRAFT to APPROVED
   - Open questions section updated with resolutions
   - Ticket model includes `sold` field throughout
   - Reservation flow updated with Redisson fallback
   - New `MarkSold` method added to QuotaManager, TicketRepository interfaces
   - `orders.order.completed` event schema documented
   - Kafka consumer updated with `handleOrderCompleted` handler

### Next steps

1. **Begin implementation** starting with proto changes (Phase 1 in quota doc / Phase 0 in seating doc)
2. Implementation order: proto → ticket-service quota → order-service changes → venue-service scaffold
3. Non-blocking design questions (seat labels, rendering tech, template sharing) deferred to relevant implementation phases

---

## Session: 2026-04-01 — Post-audit lint/type hardening: PR #16 ⏳ AWAITING REVIEW

**Branch:** `fix/audit-typescript-errors` → PR #16 (open, awaiting owner review).

### What was done

Completed a full lint and type-check pass across all six services, discovering and fixing post-audit regressions not captured by the AUDIT-TODO checklist.

**1. auth-service — TypeScript errors in integration test (9 → 0)**
- File: `test/auth.integration.spec.ts`
- Root cause A: Audit fix O-04 refactored `GlobalExceptionFilter` to require DI-injected `Logger`; the integration test still called `new GlobalExceptionFilter()` with no argument → TS2554.
  Fix: added `import { Logger } from 'nestjs-pino'`; changed instantiation to `new GlobalExceptionFilter(moduleRef.get(Logger))`.
- Root cause B: supertest v7.2.2 + `@types/supertest ^6.0.3` type mismatch — v7 types the `set-cookie` response header as `string`, but the test code cast to `string[]` → 8× TS2352.
  Fix: inserted `unknown` intermediary: `as unknown as string[] | undefined`.

**2. client — TypeScript errors in unit test (2 → 0)**
- File: `__tests__/pages.test.tsx`
- Root cause: `vi.fn<() => Promise<TicketPage>>()` is typed as a no-argument function; spreading `unknown[]` into it fails TS2556.
  Fix: `mockFn(...args as Parameters<typeof mockFn>)` at both call sites.

**3. order-service — Checkstyle configuration and import hygiene**
- AGENTS.md mandates `mvn -q checkstyle:check` but no plugin existed; the
  default Sun checks produced 676 violations and Google checks produced 817 (all on
  4-space indentation the project doesn't use).
- Created `services/order-service/checkstyle.xml` — project-tuned rules:
  `AvoidStarImport`, `UnusedImports`, `RedundantImport`, `IllegalImport`,
  naming conventions (TypeName, MemberName, ParameterName, LocalVariableName,
  MethodName, PackageName), `ConstantName` with SLF4J `log`/`logger` exception,
  `EmptyCatchBlock`, `FallThrough`, `MultipleVariableDeclarations`, `UpperEll`,
  `ArrayTypeStyle`, `ModifierOrder`.
- Updated `pom.xml` to reference `checkstyle.xml` instead of `google_checks.xml`.
- Fixed 4 star-import violations:
  - `Order.java`: `jakarta.persistence.*` → 12 explicit imports
  - `OutboxMessage.java`: `jakarta.persistence.*` → 7 explicit imports
  - `OrderTicket.java`: `jakarta.persistence.*` → 7 explicit imports
  - `OrderController.java`: `org.springframework.web.bind.annotation.*` → 8 explicit imports
- Removed stale unused `KafkaTemplate` import from `OutboxRelay.java`.

### Verification Matrix

| Service | Command | Result |
|---|---|---|
| auth-service | `pnpm tsc --noEmit` | ✅ 0 errors |
| client | `pnpm tsc --noEmit` | ✅ 0 errors |
| payment-service | `pnpm tsc --noEmit` | ✅ 0 errors |
| ticket-service | `go vet ./...` | ✅ clean |
| expiration-service | `go vet ./...` | ✅ clean |
| order-service | `mvn -q checkstyle:check` | ✅ 0 violations |

### PR Summary

**PR #16**: fix: post-audit lint and type hardening
- **Branch**: `fix/audit-typescript-errors`
- **Status**: ⏳ AWAITING OWNER REVIEW
- **Commits**: 1
- **Files Changed**: 9 (+115 / -17 lines)
- **Breaking Changes**: None
