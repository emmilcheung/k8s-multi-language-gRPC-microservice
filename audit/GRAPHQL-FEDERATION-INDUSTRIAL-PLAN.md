# GraphQL Federation Industrial Remediation Plan

> Date: 2026-04-24
> Branch: feature/graphql-federation
> Goal: Raise the GraphQL migration from current B+ audit status to enterprise A / industrial standard release readiness.

---

## 1. Objective

This plan converts the current audit findings into a delivery program with explicit gates.

Industrial standard in this repository means:

- one trust boundary for authentication
- no subgraph-specific auth regressions
- executable evidence for security claims
- staging and production parity for controls that matter
- release gates enforced by tests, not by verbal assurance

Current status after re-audit:

- Fixed: server-side client GraphQL now routes through Kong
- Fixed: order-service, ticket-service, auth-service, payment-service, and user-service now validate signed identity in GraphQL paths
- Improved: Apollo Router telemetry and staging/prod NetworkPolicy parity
- Still open: venue-service GraphQL does not validate `X-User-Id-Sig`
- Still incomplete: end-to-end proof for all high-risk federation trust paths is not yet runnable as final audit evidence

---

## 2. Exit Criteria For A Grade

The branch reaches A only when all items below are true:

1. Every GraphQL subgraph that consumes authenticated identity validates the signed header contract consistently.
2. A clean local or CI-backed stack runs federation E2E and proves:
   - invalid JWT is rejected
   - forged identity headers are stripped
   - signed identity is enforced across every protected subgraph
   - SSR GraphQL requests route through Kong
3. Apollo Router deployment is production-hardened to repo standard, including immutable image pinning.
4. The audit evidence is repeatable by command, not by code inspection alone.

Until then, the branch is not industrial-standard ready.

---

## 3. Priority Workstreams

### WS-1 Close Venue-Service GraphQL Trust Gap

Severity: P1

Problem:

- `venue-service` REST handlers validate `X-User-Id-Sig`, but the GraphQL handler currently serves requests without validating the signed identity chain.
- This breaks the branch's own federation design contract and leaves one subgraph outside the shared trust model.

Current evidence:

- GraphQL handler at `services/venue-service/cmd/server/main.go`
- GraphQL resolver at `services/venue-service/internal/graphql/schema.resolvers.go`
- Existing REST validation at `services/venue-service/internal/handler/venue_handler.go`

Required changes:

1. Add GraphQL request validation in venue-service before `gqlSrv.ServeHTTP(...)`.
2. Reuse the existing `UserIDSignatureValidator` implementation rather than introducing a parallel auth path.
3. Fail closed when `X-User-Id` is present but `X-User-Id-Sig` is missing or invalid.
4. Keep unauthenticated behavior explicit if the schema is intended to allow public access; document which fields are public.

Acceptance criteria:

- Venue GraphQL path enforces the same signed identity contract as venue REST.
- No code path in venue GraphQL trusts `X-User-Id` without validating the signature first.
- Behavior is documented in code comments and test names.

Verification:

- `go test ./services/venue-service/...`
- focused test proving invalid signature returns unauthorized on `/graphql`

### WS-2 Add Venue GraphQL Security Tests

Severity: P1

Problem:

- There is currently no venue GraphQL test evidence for signature enforcement.
- An industrial audit cannot accept a security control that is present only by inspection.

Required changes:

1. Add unit or handler tests for venue GraphQL request validation.
2. Cover at least these cases:
   - valid user ID + valid signature
   - user ID + missing signature
   - user ID + invalid signature
   - unauthenticated request if public access is intended

Acceptance criteria:

- Tests fail if signature enforcement is removed.
- Test names describe the auth rule clearly.

Verification:

- `go test ./services/venue-service/... -run GraphQL|Signature`

### WS-3 Strengthen Federation E2E To Audit Grade

Severity: P1

Problem:

- The branch now has a meaningful Playwright federation suite, but final audit evidence still depends on that suite being runnable against a live stack.
- Coverage is still concentrated on auth, order, and SSR flows; the remaining subgraph trust path needs explicit proof.

Required changes:

1. Extend `services/client/tests/e2e/graphql-federation.spec.ts` with at least one venue-related protected flow.
2. Add a case that proves signed identity enforcement is active at the subgraph boundary, not just Kong ingress.
3. Add one cross-subgraph test that exercises entity resolution plus protected field behavior.
4. Ensure the suite is runnable from a documented stack boot command.

Minimum E2E matrix:

- valid JWT -> protected GraphQL succeeds
- malformed JWT -> rejected by Kong
- forged `X-User-Id` header -> stripped
- valid JWT but tampered downstream signed identity -> rejected by protected subgraph
- SSR page -> uses Kong-backed GraphQL path successfully
- venue-related GraphQL path -> protected behavior proven

Acceptance criteria:

- A single command can boot the stack and run the federation spec.
- Test output is clean on a fresh environment.

Verification:

- stack up command documented in repo
- `pnpm --dir services/client test:e2e -- graphql-federation.spec.ts`

### WS-4 Add CI Gate For Federation Security

Severity: P1

Problem:

- Today the branch can regress on GraphQL auth even if local tests exist, because there is no mandatory release gate specific to federation security.

Required changes:

1. Add a CI job for the GraphQL federation security suite.
2. Fail the pipeline if the guard-level tests or federation E2E tests fail.
3. Publish artifacts for the E2E run so audit evidence is reviewable.

Acceptance criteria:

- Pull requests cannot merge with a broken federation trust model.
- CI clearly separates unit guard failures from stack-level E2E failures.

Verification:

- CI workflow contains a dedicated GraphQL federation gate
- one successful CI run captured in the audit record

### WS-5 Finish Apollo Router Supply-Chain Hardening

Severity: P3

Problem:

- The Apollo Router image is still tag-pinned instead of digest-pinned.
- That misses the repo's own industrial supply-chain standard.

Required changes:

1. Pin the Apollo Router image by digest in Helm values and any production-oriented manifests.
2. Keep local-dev exceptions explicit if the team wants tag-based iteration outside release paths.

Acceptance criteria:

- Production-oriented config uses immutable image references.

Verification:

- `grep -n "apollographql/router.*sha256" infra/helm/** services/** docker-compose.yml`

---

## 4. Execution Order

Use this sequence. Do not skip gates.

### Phase A: Trust Closure

- WS-1 Venue-service GraphQL signature enforcement
- WS-2 Venue-service GraphQL security tests

Gate A:

- all GraphQL subgraphs use one consistent signed identity model
- targeted service tests pass

### Phase B: Evidence Closure

- WS-3 Federation E2E expansion and execution

Gate B:

- live stack run proves the security claims end-to-end
- audit no longer depends on source inspection for the remaining high-risk path

### Phase C: Release Gate Closure

- WS-4 CI federation security gate
- WS-5 Router digest pinning

Gate C:

- branch is protected by executable release controls
- supply-chain baseline matches repo standard

---

## 5. Delivery Model

Recommended owners:

- Platform / Gateway owner: Kong route, Apollo Router, CI gate
- Venue-service owner: WS-1 and WS-2
- Client / E2E owner: WS-3
- Release engineering owner: WS-5

Recommended implementation style:

- smallest bounded PR per workstream
- each PR includes tests for the changed trust boundary
- no mixed feature work in the remediation PRs

Recommended PR order:

1. `fix(venue-service): enforce signed identity on graphql endpoint`
2. `test(venue-service): add graphql signature validation coverage`
3. `test(client): expand federation security e2e coverage`
4. `ci(graphql): add federation security gate`
5. `chore(router): pin apollo-router image digest`

---

## 6. Audit Gate Checklist

Use this before requesting the next audit.

- [ ] Venue GraphQL rejects invalid or missing signatures when user identity is present
- [ ] Venue GraphQL tests exist and pass
- [ ] Federation Playwright suite passes on a live stack
- [ ] Live stack evidence is attached or recorded
- [ ] CI blocks regressions on federation security tests
- [ ] Apollo Router image is digest-pinned in release config
- [ ] No remaining subgraph trusts `X-User-Id` without signature validation

When every item above is checked, the branch is ready for an A-grade re-audit.

---

## 7. What Not To Accept

The following are not sufficient for industrial signoff:

- "we fixed it" without a runnable test
- a guard in one service but not all subgraphs using authenticated identity
- a local-only passing scenario without CI enforcement
- a code review statement that assumes Kong alone is enough while a subgraph still trusts headers directly

The standard is evidence-backed consistency.
