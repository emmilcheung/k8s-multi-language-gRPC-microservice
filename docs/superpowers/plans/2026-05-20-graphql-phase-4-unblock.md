# GraphQL Phase 4 Contract Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the stalled GraphQL Phase 4 migration by aligning the federated GraphQL contracts with the service-layer contracts that already exist in `order-service`, `payment-service`, and `venue-service`.

**Architecture:** Do **not** invent new persistence just to satisfy the current SDL. Instead, reshape the GraphQL contract so federation and venue mutations match the real service boundaries: resolve `Order.payment` by `orderId`, keep seating-plan creation ticket-first, and align seat release + venue section fields with the existing REST/service contracts. Once these contracts are corrected, the original Phase 4 handoff can resume without guessing or hidden business logic.

**Tech Stack:** Spring GraphQL (`order-service`), NestJS GraphQL Federation (`payment-service`), Go gqlgen (`venue-service`), Apollo Router (`services/apollo-router`), GraphQL Code Generator (`services/client`).

---

## File map

- Modify: `services/payment-service/src/graphql/schema.graphql`
- Modify: `services/payment-service/src/graphql/payment.resolver.ts`
- Modify: `services/payment-service/src/modules/payments/payments.service.ts`
- Modify: `services/payment-service/src/graphql/payment.resolver.spec.ts`
- Modify: `services/order-service/src/main/resources/schema/schema.graphqls`
- Modify: `services/order-service/src/main/java/com/ticketing/orders/graphql/OrderGraphqlController.java`
- Modify: `services/order-service/src/test/java/com/ticketing/orders/graphql/OrderControllerTest.java`
- Modify: `services/venue-service/internal/graphql/schema.graphqls`
- Modify: `services/apollo-router/supergraph.graphql`
- Modify: `docs/superpowers/plans/2026-05-20-graphql-phase-4-handoff.md`
- Create: `docs/superpowers/plans/2026-05-20-graphql-phase-4-unblock.md` (this file)

---

### Task 1: Unblock `Order.payment` without adding a new `paymentId` persistence path

**Files:**
- Modify: `services/payment-service/src/graphql/schema.graphql`
- Modify: `services/payment-service/src/graphql/payment.resolver.ts`
- Modify: `services/payment-service/src/modules/payments/payments.service.ts`
- Modify: `services/payment-service/src/graphql/payment.resolver.spec.ts`
- Modify: `services/order-service/src/main/resources/schema/schema.graphqls`
- Modify: `services/order-service/src/main/java/com/ticketing/orders/graphql/OrderGraphqlController.java`
- Modify: `services/order-service/src/test/java/com/ticketing/orders/graphql/OrderControllerTest.java`
- Test: `services/payment-service/src/graphql/payment.resolver.spec.ts`
- Test: `services/order-service/src/test/java/com/ticketing/orders/graphql/OrderControllerTest.java`

- [ ] **Step 1: Write the failing payment resolver test for `orderId` federation**

Add a resolver-spec case that proves `Payment.resolveReference` accepts an entity reference keyed by `orderId`:

```ts
it('resolves Payment reference by orderId', async () => {
  paymentsService.findByOrderId = vi.fn().mockResolvedValue({
    id: 'pay_123',
    orderId: 'ord_123',
    userId: 'user_123',
    amount: 1200,
    currency: 'usd',
    status: 'CAPTURED',
    createdAt: new Date().toISOString(),
  });

  const result = await resolver.resolveReference(
    { __typename: 'Payment', orderId: 'ord_123' },
    { req: { headers: { 'x-user-id': 'user_123' } } },
  );

  expect(paymentsService.findByOrderId).toHaveBeenCalledWith('ord_123');
  expect(result?.id).toBe('pay_123');
});
```

- [ ] **Step 2: Run the payment resolver test to verify it fails**

Run:

```bash
cd services/payment-service && pnpm test -- payment.resolver.spec.ts
```

Expected: FAIL because `resolveReference()` only supports `id`, and `PaymentsService` does not expose `findByOrderId()`.

- [ ] **Step 3: Add `orderId` as an alternate federation key in payment-service**

Update the SDL so `Payment` can be referenced by either `id` or `orderId`:

```graphql
type Payment
  @key(fields: "id")
  @key(fields: "orderId") {
  id: ID!
  orderId: ID!
  amount: Int!
  currency: String!
  status: PaymentStatus!
  createdAt: String!
}
```

Add the smallest service API needed by the resolver:

```ts
async findByOrderId(orderId: string): Promise<Payment> {
  const payment = await this.paymentsRepo.findByOrderId(orderId);
  if (!payment) {
    throw new NotFoundException({
      error: { code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' },
    });
  }
  return payment;
}
```

Teach `resolveReference()` to support both keys:

```ts
type PaymentReference = { __typename: string; id?: string; orderId?: string };

@ResolveReference()
@UseGuards(UserIdSigGuard)
async resolveReference(reference: PaymentReference, @Context() ctx: GqlContext) {
  try {
    const payment = reference.id
      ? await this.paymentsService.findById(reference.id)
      : reference.orderId
        ? await this.paymentsService.findByOrderId(reference.orderId)
        : null;
    const requesterId = ctx.req.headers['x-user-id'] as string;
    if (!payment || !requesterId || payment.userId !== requesterId) return null;
    return payment;
  } catch (e) {
    if (e instanceof NotFoundException) return null;
    throw e;
  }
}
```

- [ ] **Step 4: Write the failing order-service controller test for `Order.payment`**

Add a controller test that proves an order resolves to a federated `Payment` reference **by orderId**:

```java
@Test
void payment_returnsFederatedReferenceForOwner() {
    String userId = UUID.randomUUID().toString();
    OrderResponse order = new OrderResponse();
    ReflectionTestUtils.setField(order, "id", UUID.fromString("11111111-1111-1111-1111-111111111111"));
    ReflectionTestUtils.setField(order, "userId", UUID.fromString(userId));

    Map<String, Object> result = controller.payment(order, ctxWithUserId(userId));

    assertThat(result).containsEntry("__typename", "Payment");
    assertThat(result).containsEntry("orderId", "11111111-1111-1111-1111-111111111111");
}
```

- [ ] **Step 5: Run the order-service controller test to verify it fails**

Run:

```bash
cd services/order-service && mvn -q -Dtest=OrderControllerTest test
```

Expected: FAIL because `OrderGraphqlController` does not yet expose `@SchemaMapping(typeName = "Order", field = "payment")`.

- [ ] **Step 6: Implement the order-service federated edge without schema-side persistence changes**

Do **not** add `paymentId` to the JPA entity or DB schema. Return a federated reference keyed by the order's own ID:

```java
@SchemaMapping(typeName = "Order", field = "payment")
public Map<String, Object> payment(OrderResponse order, GraphQLContext ctx) {
    String requesterId = ctx.get(UserIdInterceptor.USER_ID_KEY);
    if (requesterId == null || order == null || order.getUserId() == null) {
        return null;
    }
    if (!order.getUserId().toString().equals(requesterId)) {
        return null;
    }
    return Map.of(
            "__typename", "Payment",
            "orderId", order.getId().toString()
    );
}
```

Leave `createSeatedOrder` in place and verify it still delegates to `orderService.createSeatedOrder(...)`.

- [ ] **Step 7: Run service checks for Task 1**

Run:

```bash
cd services/payment-service && pnpm lint && pnpm tsc --noEmit && pnpm test
cd /Users/emmil/Desktop/code/microservices/services/order-service && mvn -q test
cd /Users/emmil/Desktop/code/microservices/services/apollo-router && rover supergraph compose --config supergraph-config.yaml --output supergraph.graphql
cd /Users/emmil/Desktop/code/microservices/services/client && pnpm codegen
```

Expected:
- payment-service tests PASS
- order-service tests PASS
- supergraph composition PASS
- client codegen PASS with refreshed `Payment` entity key metadata

- [ ] **Step 8: Commit Task 1**

```bash
git add \
  services/payment-service/src/graphql/schema.graphql \
  services/payment-service/src/graphql/payment.resolver.ts \
  services/payment-service/src/modules/payments/payments.service.ts \
  services/payment-service/src/graphql/payment.resolver.spec.ts \
  services/order-service/src/main/resources/schema/schema.graphqls \
  services/order-service/src/main/java/com/ticketing/orders/graphql/OrderGraphqlController.java \
  services/order-service/src/test/java/com/ticketing/orders/graphql/OrderControllerTest.java \
  services/apollo-router/supergraph.graphql
git commit -m "feat(order-service,payment-service): federate Order.payment by orderId"
```

---

### Task 2: Realign the venue GraphQL SDL to the existing venue contracts

**Files:**
- Modify: `services/venue-service/internal/graphql/schema.graphqls`
- Test: `services/apollo-router/supergraph.graphql` (composition output)

- [x] **Step 1: Write the SDL changes directly from the existing REST/service contracts**

Replace the simplified venue section / seating plan / release signatures with the shapes the service already supports:

```graphql
type Venue {
  id: ID!
  organizerId: ID!
  name: String!
  capacity: Int!
  timezone: String!
  address: String!
}

enum SectionType {
  SEATED
  GA
}

type VenueSection {
  id: ID!
  venueId: ID!
  name: String!
  type: SectionType!
  rowCount: Int!
  columnCount: Int!
  displayOrder: Int!
  capacity: Int!
}

input CreateSectionInput {
  name: String!
  type: SectionType!
  rowCount: Int
  columnCount: Int!
  displayOrder: Int
}

input UpdateSectionInput {
  name: String
  rowCount: Int
  columnCount: Int
  displayOrder: Int
}

input CreateSeatingPlanInput {
  venueId: ID!
  ticketId: ID!
  name: String!
  maxSeatsPerOrder: Int
  assignmentMode: AssignmentMode!
  pricingMode: String
}

type SeatHoldResult {
  held: [ID!]!
  expiresAt: String!
}

input CreateVenueInput {
  name: String!
  capacity: Int!
  timezone: String!
  address: String
}

input UpdateVenueInput {
  name: String!
  capacity: Int!
  timezone: String!
  address: String
}

type PriceTier {
  id: ID!
  planId: ID!
  name: String!
  price: String!
}

input CreatePriceTierInput {
  name: String!
  price: String!
}

type Mutation {
  createVenue(input: CreateVenueInput!): Venue!
  updateVenue(id: ID!, input: UpdateVenueInput!): Venue!
  createSection(venueId: ID!, input: CreateSectionInput!): VenueSection!
  updateSection(id: ID!, input: UpdateSectionInput!): VenueSection!
  createSeatingPlan(input: CreateSeatingPlanInput!): SeatingPlan!
  updateSeatingPlan(id: ID!, input: UpdateSeatingPlanInput!): SeatingPlan!
  activateSeatingPlan(id: ID!): SeatingPlan!
  deactivateSeatingPlan(id: ID!): SeatingPlan!
  createPriceTier(planId: ID!, input: CreatePriceTierInput!): PriceTier!
  holdSeats(planId: ID!, seatIds: [ID!]!): SeatHoldResult!
  releaseSeats(planId: ID!, seatIds: [ID!]!): Boolean!
}
```

- [x] **Step 2: Define the `capacity` rule explicitly so resolvers do not guess**

Document the resolver rule in the SDL comments and later resolver implementation:

```graphql
# Derived field:
# - GA sections: capacity = columnCount
# - seated sections: capacity = rowCount * columnCount
capacity: Int!
```

This avoids inventing a new persisted `capacity` column on `VenueSection`.

- [x] **Step 2a: Keep the task SDL-only and defer gqlgen regeneration to the resolver task**

Task 2 is intentionally limited to:
- `services/venue-service/internal/graphql/schema.graphqls`
- `services/apollo-router/supergraph.graphql`

Do **not** regenerate `services/venue-service/internal/graphql/generated.go` in this task. The executable gqlgen schema and resolver stubs are refreshed in the later venue resolver task, where the new mutation surface is actually wired.

- [x] **Step 3: Recompose the supergraph to verify the revised SDL is valid**

Run:

```bash
cd services/apollo-router && rover supergraph compose --config supergraph-config.yaml --output supergraph.graphql
git diff --stat supergraph.graphql
```

Expected: PASS with a non-zero diff reflecting the venue contract corrections.

- [x] **Step 4: Commit Task 2**

```bash
git add services/venue-service/internal/graphql/schema.graphqls services/apollo-router/supergraph.graphql
git commit -m "feat(venue-service): align GraphQL SDL with existing venue contracts"
```

---

### Task 3: Refresh the Phase 4 handoff plan so the next executor does not repeat the same dead end

**Files:**
- Modify: `docs/superpowers/plans/2026-05-20-graphql-phase-4-handoff.md`

- [x] **Step 1: Update the blocker notes and resolver instructions**

Replace the incorrect assumptions in the handoff with the new contract rules:

```md
- `Order.payment` resolves through payment-service federation by `orderId`; do not add `paymentId` persistence to order-service for this branch.
- `createSeatingPlan` requires `ticketId` because venue-service is ticket-first at creation time.
- `releaseSeats` uses `seatIds`, matching the existing hold manager; do not invent a holdId -> seats lookup path.
- `VenueSection.capacity` is derived from row/column counts; do not add a new persisted field for this branch.
```

Update any client migration sections that mention `holdId` so they use the real response shape:

```md
- `HoldSeats.graphql` returns `{ held, expiresAt }`
- `ReleaseSeats.graphql` accepts `planId` + `seatIds`
```

- [x] **Step 2: Add an explicit restart point**

Append a short execution note:

```md
### Restart point after unblock

Resume the original execution order from:
1. Finish Task 1 checks and commit if not already committed.
2. Implement venue-service resolvers against the corrected SDL.
3. Recompose supergraph and rerun client codegen.
4. Continue Phase 4.1–4.7.
```

- [x] **Step 3: Commit Task 3**

```bash
git add docs/superpowers/plans/2026-05-20-graphql-phase-4-handoff.md
git commit -m "docs(graphql): revise phase 4 handoff for contract-unblock work"
```

---

### Task 4: Validation and clean handoff

**Files:**
- Modify: `services/apollo-router/supergraph.graphql`
- Modify: `docs/superpowers/plans/2026-05-20-graphql-phase-4-verification.md`

- [x] **Step 1: Record verification output**

Append these commands and the last ~15 lines of output to `docs/superpowers/plans/2026-05-20-graphql-phase-4-verification.md`:

```bash
cd services/payment-service && pnpm lint && pnpm tsc --noEmit && pnpm test
cd services/order-service && mvn -q test
cd services/apollo-router && rover supergraph compose --config supergraph-config.yaml --output supergraph.graphql
cd services/client && pnpm codegen
```

Expected: PASS/PASS/PASS/PASS for the unblock work.

- [x] **Step 2: Confirm the branch is ready for the next executor**

Run:

```bash
git status -s
git log --oneline feat/client-graphql-foundation ^main
```

Expected:
- only in-scope files remain changed
- the three unblock commits are present
- no extra resets of prior branch work

- [x] **Step 3: Push and stop**

```bash
git push origin feat/client-graphql-foundation
```

Expected: remote updated; stop and hand the branch back for the resumed Phase 4 executor.

---

## Self-review notes

- **Spec coverage:** This plan covers the two real blockers the executor validated (`Order.payment`, venue SDL mismatch) and updates the handoff doc so the next executor resumes from corrected assumptions.
- **Placeholder scan:** No `TODO`, `TBD`, or “similar to above” placeholders remain.
- **Type consistency:** The revised plan consistently uses `orderId` for payment federation, `ticketId` for seating-plan creation, and `seatIds` for hold/release operations.
