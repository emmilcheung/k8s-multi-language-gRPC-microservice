# GraphQL Phase 4 Verification

## Order-service test

**Command**

```bash
cd services/order-service && mvn -q test
```

**Output tail**

```text
at org.apache.maven.surefire.api.util.ReflectionUtils.invokeMethodWithArray(ReflectionUtils.java:125)
at org.apache.maven.surefire.junitplatform.LauncherAdapter.executeWithCancellationToken(LauncherAdapter.java:68)
at org.apache.maven.surefire.junitplatform.LauncherAdapter.execute(LauncherAdapter.java:54)
at org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.execute(JUnitPlatformProvider.java:203)
at org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.invokeAllTests(JUnitPlatformProvider.java:168)
at org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.invoke(JUnitPlatformProvider.java:136)
at org.apache.maven.surefire.booter.ForkedBooter.runSuitesInProcess(ForkedBooter.java:385)
at org.apache.maven.surefire.booter.ForkedBooter.execute(ForkedBooter.java:162)
at org.apache.maven.surefire.booter.ForkedBooter.run(ForkedBooter.java:507)
at org.apache.maven.surefire.booter.ForkedBooter.main(ForkedBooter.java:495)
19:04:56.603 [main] INFO com.ticketing.orders.service.OrderTransactionService -- Local ticket replica not found; creating from gRPC response ticketId=d887be71-43a8-4ebb-bc72-cd1759a56e93
19:04:56.604 [main] INFO com.ticketing.orders.service.OrderTransactionService -- Order created orderId=f017db96-aa09-4a8e-bdb4-b0e641b785df userId=b3701bc6-2240-4321-bbb4-7b717e2a0118 ticketId=d887be71-43a8-4ebb-bc72-cd1759a56e93 reservationId=bd52dae7-a572-48f8-bb4d-f1775432f193 quantity=1
19:04:56.608 [main] INFO com.ticketing.orders.service.OrderService -- Order cancelled orderId=054d0067-721e-4986-91a6-fb8d09b181ee userId=f27b430a-9bd6-474b-a53a-406975c815ec
19:04:56.613 [main] INFO com.ticketing.orders.service.OrderService -- Order cancelled after payment failure orderId=35cf865c-6f1f-49bc-aa5d-2dc6bec2de82 reservationId=null orderType=GA
19:04:56.619 [main] INFO com.ticketing.orders.service.SeatedOrderTransactionService -- Seated order created orderId=67d81c66-a1e7-4f53-a9a7-ab0ab38ecfaf userId=55fc8c0e-714d-4fc0-a007-dbcffd610869 ticketId=7350d9a3-65ae-48e5-9bea-d2a7b65f6b2a reservationId=8662fc9a-3106-4691-9667-e107e1d5216b quantity=1 orderType=AUTO_ASSIGN_SEATED seats=1
```

**Result**: PASS via `mvn -q test` (the repo does not currently include `services/order-service/gradlew`).

## Supergraph composition

**Command**

```bash
cd services/apollo-router && rover supergraph compose --config supergraph-config.yaml --output supergraph.graphql
git diff --stat supergraph.graphql
```

**Output tail**

```text
merging supergraph schema files

Supergraph Schema was printed to /Users/emmil/Desktop/code/microservices/services/apollo-router/supergraph.graphql
 services/apollo-router/supergraph.graphql | 360 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 355 insertions(+), 5 deletions(-)
```

**Result**: PASS.

## Client codegen

**Command**

```bash
cd services/client && pnpm codegen
```

**Output tail**

```text
> tsx ./scripts/fetch-schema.ts

[fetch-schema] wrote 15629 bytes from local supergraph -> /Users/emmil/Desktop/code/microservices/services/client/.graphql-cache/supergraph.graphql
[STARTED] Parse Configuration
[SUCCESS] Parse Configuration
[STARTED] Generate outputs
[STARTED] Generate to lib/graphql/generated/index.ts
[STARTED] Load GraphQL schemas
[SUCCESS] Load GraphQL schemas
[STARTED] Load GraphQL documents
[SUCCESS] Load GraphQL documents
[STARTED] Generate
[SUCCESS] Generate
[SUCCESS] Generate to lib/graphql/generated/index.ts
[SUCCESS] Generate outputs
```

**Result**: PASS.

## R2 venue-service blocker

**Status**: BLOCKED.

**Why**

- `createSeatingPlan` cannot be implemented correctly from the current GraphQL schema without inventing data: the schema only supplies `venueId`, but the existing repository contract requires a real `ticketId` at creation time.
- `releaseSeats(planId, holdId)` cannot be delegated correctly with the current service layer because the existing hold manager releases by `seatIDs`, not by `holdId`, and there is no lookup path from hold ID to seats in the current GraphQL layer.
- `VenueSection.capacity` exists in the GraphQL schema, but the existing venue section model/repository does not persist a capacity field, so accepting it would silently drop data.

**Result**: FAIL — stopped rather than guess or add unsupported business logic.

## Unblock validation rerun (current)

### Payment-service checks

**Command**

```bash
cd services/payment-service && pnpm lint && pnpm tsc --noEmit && pnpm test
```

**Output tail**

```text
 ✓ src/kafka/kafka.config.spec.ts (2 tests) 3ms
 ✓ src/common/security/user-id-signature.validator.spec.ts (6 tests) 2ms
 ✓ src/modules/payments/order-service.client.spec.ts (5 tests) 19ms
 ✓ src/graphql/guards/user-id-sig.guard.spec.ts (4 tests) 3ms
 ✓ src/modules/payments/outbox-relay.service.spec.ts (1 test) 3ms
 ✓ src/modules/payments/payments.service.spec.ts (32 tests) 14ms
 ✓ src/graphql/payment.resolver.spec.ts (10 tests) 3ms
 ✓ src/modules/payments/payments.controller.spec.ts (12 tests) 6ms

 Test Files  8 passed (8)
      Tests  72 passed (72)
   Start at  21:44:48
   Duration  962ms (transform 662ms, setup 0ms, import 4.16s, tests 53ms, environment 0ms)
```

**Result**: PASS.

### Order-service test (rerun)

**Command**

```bash
cd services/order-service && mvn -q test
```

**Output tail**

```text
	at org.apache.maven.surefire.api.util.ReflectionUtils.invokeMethodWithArray(ReflectionUtils.java:125)
	at org.apache.maven.surefire.junitplatform.LauncherAdapter.executeWithCancellationToken(LauncherAdapter.java:68)
	at org.apache.maven.surefire.junitplatform.LauncherAdapter.execute(LauncherAdapter.java:54)
	at org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.execute(JUnitPlatformProvider.java:203)
	at org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.invokeAllTests(JUnitPlatformProvider.java:168)
	at org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.invoke(JUnitPlatformProvider.java:136)
	at org.apache.maven.surefire.booter.ForkedBooter.runSuitesInProcess(ForkedBooter.java:385)
	at org.apache.maven.surefire.booter.ForkedBooter.execute(ForkedBooter.java:162)
	at org.apache.maven.surefire.booter.ForkedBooter.run(ForkedBooter.java:507)
	at org.apache.maven.surefire.booter.ForkedBooter.main(ForkedBooter.java:495)
21:44:46.983 [main] INFO com.ticketing.orders.service.OrderTransactionService -- Local ticket replica not found; creating from gRPC response ticketId=598bec7a-b8e9-4c06-8ea9-6995d1015015
21:44:46.985 [main] INFO com.ticketing.orders.service.OrderTransactionService -- Order created orderId=39e036b2-26d0-4076-9ee5-9e481e0b8fcc userId=48873c64-a22c-48a0-8a86-302b5a739686 ticketId=598bec7a-b8e9-4c06-8ea9-6995d1015015 reservationId=58cca156-239c-434b-b4cd-fd83290704e4 quantity=1
21:44:46.995 [main] INFO com.ticketing.orders.service.OrderService -- Order cancelled orderId=60777e43-3ddb-4144-8875-462a657d1dd7 userId=f8f4ed19-09db-4177-b398-70b62702f361
21:44:47.002 [main] INFO com.ticketing.orders.service.OrderService -- Order cancelled after payment failure orderId=fa581e8a-9226-4483-ae35-5bc577436ea9 reservationId=null orderType=GA
21:44:47.008 [main] INFO com.ticketing.orders.service.SeatedOrderTransactionService -- Seated order created orderId=569bc958-5041-4b61-a4ea-bc201212666f userId=ff42b5ec-caf2-46a4-b5df-f8ed9fff25a5 ticketId=6219e10d-0ca4-4b6e-a440-93cf52ac3f03 reservationId=6eb5386c-e062-45e0-a498-a9fa8fd50c25 quantity=1 orderType=AUTO_ASSIGN_SEATED seats=1
```

**Result**: PASS.

### Supergraph composition (rerun)

**Command**

```bash
cd services/apollo-router && rover supergraph compose --config supergraph-config.yaml --output supergraph.graphql
```

**Output tail**

```text
merging supergraph schema files

Supergraph Schema was printed to /Users/emmil/Desktop/code/microservices/services/apollo-router/supergraph.graphql
```

**Result**: PASS.

### Client codegen (rerun)

**Command**

```bash
cd services/client && pnpm codegen
```

**Output tail**

```text
> tsx ./scripts/fetch-schema.ts

[fetch-schema] wrote 14490 bytes from local supergraph -> /Users/emmil/Desktop/code/microservices/services/client/.graphql-cache/supergraph.graphql
[STARTED] Parse Configuration
[SUCCESS] Parse Configuration
[STARTED] Generate outputs
[STARTED] Generate to lib/graphql/generated/index.ts
[STARTED] Load GraphQL schemas
[SUCCESS] Load GraphQL schemas
[STARTED] Load GraphQL documents
[SUCCESS] Load GraphQL documents
[STARTED] Generate
[SUCCESS] Generate
[SUCCESS] Generate to lib/graphql/generated/index.ts
[SUCCESS] Generate outputs
```

**Result**: PASS.

### Branch state

**Command**

```bash
git status -s
git log --oneline feat/client-graphql-foundation ^main
```

**Output tail**

```text
 M services/ticket-service/internal/graphql/model.go
 M services/ticket-service/internal/graphql/schema.graphqls
 M services/ticket-service/internal/graphql/schema.resolvers.go
 M services/user-service/src/graphql/graphql.module.ts
 M services/user-service/src/graphql/schema.graphql
 M services/user-service/src/graphql/user.resolver.spec.ts
 M services/user-service/src/graphql/user.resolver.ts
?? .claude/worktrees/
?? docs/notes/interview.md
?? docs/superpowers/plans/2026-05-20-graphql-phase-4-unblock.md
?? docs/superpowers/plans/2026-05-20-graphql-phase-4-verification.md
?? services/client/codegen.ts
?? services/client/lib/graphql/
?? services/client/scripts/fetch-schema.ts
?? services/ticket-service/tools.go
```

**Result**: HEAD contains the unblock commits (`700b9e1`, `bff58ab`, `920e0e2`) and no reset/rewrite was performed, but the working tree is still locally dirty from broader Phase 4 branch changes plus unrelated untracked artifacts (`.claude/worktrees/`, `docs/notes/interview.md`). Those files were observed, not cleaned, to avoid touching pre-existing user/branch state.

### Unblock summary

- Task 1 complete: `Order.payment` now federates through payment-service by `orderId`.
- Task 2 complete: venue SDL now matches existing venue-service contracts, with gqlgen/runtime wiring explicitly deferred to the later resolver task.
- Task 3 complete: the Phase 4 handoff now reflects the corrected contracts, commands, and restart point.
