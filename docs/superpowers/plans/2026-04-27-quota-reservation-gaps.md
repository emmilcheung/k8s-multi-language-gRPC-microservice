# Quota Reservation — Closing the Gaps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining gaps in the quota-based reservation system after the core implementation (design doc `docs/plan/quota-reservation-design.md`) landed in prior sessions.

**Architecture:** All backend mechanics are done — gRPC reservation, Redis Lua, Mongo ledger, Kafka consumers, reconciler. This plan targets only what is genuinely missing: ticket Kafka events lack quota inventory fields (design §9.2), Redisson is dead code that should be removed (design §7.4), legacy Mongo documents need a backfill (design §8.1), and E2E test coverage for multi-quantity and error cases is absent.

**Tech Stack:** Go (ticket-service), Java/Spring Boot (order-service), mongosh, TypeScript/Playwright (client E2E)

---

## File Map

### Modified
| File | Change |
|---|---|
| `services/ticket-service/internal/repository/mongo_ticket_repository.go` | Add `Quota`, `Reserved`, `Sold`, `MaxPerUser` to `TicketOutboxPayload`; update `normalizePendingOutboxEvent` |
| `services/ticket-service/internal/kafka/producer.go` | Add `Quota`, `Reserved`, `Sold`, `MaxPerUser` to `TicketEventData` |
| `services/ticket-service/internal/outbox/relay.go` | Map the four new fields in `publish()` |
| `services/order-service/src/main/java/com/ticketing/orders/exception/GlobalExceptionHandler.java` | Remove `RedisException` import and handler |
| `services/order-service/pom.xml` | Remove `redisson-spring-boot-starter` dependency |
| `services/client/tests/e2e/ticketing.spec.ts` | Add multi-quantity, sold-out (409), and per-user-limit (422) E2E tests |

### Deleted
| File | Reason |
|---|---|
| `services/order-service/src/main/java/com/ticketing/orders/config/RedissonConfig.java` | Dead code — Redisson lock replaced by gRPC ReserveQuota in CP-05 |

### New
| File | Purpose |
|---|---|
| `services/ticket-service/scripts/backfill-quota.js` | One-time mongosh script to set quota/reserved/sold/maxPerUser defaults on legacy documents |

---

## Task 1: Add quota inventory fields to ticket Kafka events

**Files:**
- Modify: `services/ticket-service/internal/repository/mongo_ticket_repository.go`
- Modify: `services/ticket-service/internal/kafka/producer.go`
- Modify: `services/ticket-service/internal/outbox/relay.go`
- Test: `services/ticket-service/internal/outbox/relay_test.go`

### Design §9.2 gap

`TicketOutboxPayload` (the durable Mongo record) and `TicketEventData` (the Kafka envelope) both lack `quota`, `reserved`, `sold`, and `maxPerUser`. The relay maps one to the other. All three files need the same four fields added.

---

- [ ] **Step 1: Add fields to `TicketOutboxPayload`**

In `services/ticket-service/internal/repository/mongo_ticket_repository.go`, find the `TicketOutboxPayload` struct and add the four inventory fields:

```go
type TicketOutboxPayload struct {
	ID            string              `bson:"id"`
	Title         string              `bson:"title"`
	Price         string              `bson:"price"`
	UserID        string              `bson:"userId"`
	SeatingPlanID string              `bson:"seatingPlanId,omitempty"`
	TicketType    string              `bson:"ticketType,omitempty"`
	Quota         int                 `bson:"quota"`
	Reserved      int                 `bson:"reserved"`
	Sold          int                 `bson:"sold"`
	MaxPerUser    int                 `bson:"maxPerUser"`
	Version       int                 `bson:"version"`
	Event         *TicketOutboxDetail `bson:"event,omitempty"`
}
```

- [ ] **Step 2: Populate the new fields in `normalizePendingOutboxEvent`**

In the same file, update `normalizePendingOutboxEvent` to copy the ticket's inventory counters into the payload:

```go
func normalizePendingOutboxEvent(ticket *Ticket, event *TicketOutboxEvent) {
	event.Payload.ID = ticket.ID
	event.Payload.Title = ticket.Title
	event.Payload.Price = ticket.Price
	event.Payload.UserID = ticket.UserID
	event.Payload.SeatingPlanID = ticket.SeatingPlanID
	event.Payload.TicketType = ticket.TicketType
	event.Payload.Quota = ticket.Quota
	event.Payload.Reserved = ticket.Reserved
	event.Payload.Sold = ticket.Sold
	event.Payload.MaxPerUser = ticket.MaxPerUser
	event.Payload.Version = ticket.Version
	if ticket.Event != nil && event.Payload.Event == nil {
		var endsAt string
		if ticket.Event.EndsAt != nil {
			endsAt = ticket.Event.EndsAt.Format(time.RFC3339)
		}
		event.Payload.Event = &TicketOutboxDetail{
			Title:        ticket.Event.Title,
			Description:  ticket.Event.Description,
			StartsAt:     ticket.Event.StartsAt.Format(time.RFC3339),
			EndsAt:       endsAt,
			ImageURL:     ticket.Event.ImageURL,
			VenueName:    ticket.Event.VenueName,
			VenueAddress: ticket.Event.VenueAddress,
		}
	}
}
```

- [ ] **Step 3: Add fields to `TicketEventData`**

In `services/ticket-service/internal/kafka/producer.go`, update `TicketEventData`:

```go
type TicketEventData struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Price         string     `json:"price"`
	UserID        string     `json:"userId"`
	SeatingPlanID string     `json:"seatingPlanId,omitempty"`
	TicketType    string     `json:"ticketType,omitempty"`
	Quota         int        `json:"quota"`
	Reserved      int        `json:"reserved"`
	Sold          int        `json:"sold"`
	MaxPerUser    int        `json:"maxPerUser"`
	Version       int        `json:"version"`
	Event         *EventData `json:"event,omitempty"`
}
```

- [ ] **Step 4: Map fields in `relay.go`**

In `services/ticket-service/internal/outbox/relay.go`, update the `publish` function to map the four new fields:

```go
func (r *Relay) publish(ctx context.Context, event repository.TicketOutboxEvent) error {
	payload := kafka.TicketEventData{
		ID:            event.Payload.ID,
		Title:         event.Payload.Title,
		Price:         event.Payload.Price,
		UserID:        event.Payload.UserID,
		SeatingPlanID: event.Payload.SeatingPlanID,
		TicketType:    event.Payload.TicketType,
		Quota:         event.Payload.Quota,
		Reserved:      event.Payload.Reserved,
		Sold:          event.Payload.Sold,
		MaxPerUser:    event.Payload.MaxPerUser,
		Version:       event.Payload.Version,
	}
	if event.Payload.Event != nil {
		payload.Event = &kafka.EventData{
			Title:        event.Payload.Event.Title,
			Description:  event.Payload.Event.Description,
			StartsAt:     event.Payload.Event.StartsAt,
			EndsAt:       event.Payload.Event.EndsAt,
			ImageURL:     event.Payload.Event.ImageURL,
			VenueName:    event.Payload.Event.VenueName,
			VenueAddress: event.Payload.Event.VenueAddress,
		}
	}

	switch event.Type {
	case repository.OutboxEventTypeTicketCreated:
		return r.producer.PublishTicketCreated(ctx, payload)
	case repository.OutboxEventTypeTicketUpdated:
		return r.producer.PublishTicketUpdated(ctx, payload)
	default:
		return fmt.Errorf("unsupported outbox event type %q", event.Type)
	}
}
```

- [ ] **Step 5: Add a test assertion for quota fields in the relay test**

In `services/ticket-service/internal/outbox/relay_test.go`, find the test that asserts on the published `TicketEventData` payload. Extend it to also check that `Quota`, `Reserved`, `Sold`, and `MaxPerUser` are forwarded:

Find the test that creates a `TicketOutboxEvent` with a `TicketOutboxPayload`. Add quota fields to the payload and assert them in the captured publish call. Example — look for the existing relay test that captures `PublishTicketCreated` calls and add:

```go
// In the payload construction used by the test:
payload := repository.TicketOutboxPayload{
    ID:         "ticket-abc",
    Title:      "Test Ticket",
    Price:      "10.00",
    UserID:     "user-1",
    Quota:      50,
    Reserved:   5,
    Sold:       10,
    MaxPerUser: 4,
    Version:    3,
}

// In the assertion on the captured TicketEventData:
assert.Equal(t, 50, captured.Quota)
assert.Equal(t, 5, captured.Reserved)
assert.Equal(t, 10, captured.Sold)
assert.Equal(t, 4, captured.MaxPerUser)
```

- [ ] **Step 6: Run tests and verify they pass**

```bash
cd services/ticket-service
go test ./internal/outbox/... -v -run TestRelay
```

Expected: PASS, including assertions on the four new fields.

- [ ] **Step 7: Run full ticket-service test suite**

```bash
cd services/ticket-service
go build ./... && go vet ./...
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add services/ticket-service/internal/repository/mongo_ticket_repository.go \
        services/ticket-service/internal/kafka/producer.go \
        services/ticket-service/internal/outbox/relay.go \
        services/ticket-service/internal/outbox/relay_test.go
git commit -m "feat(ticket-service): add quota inventory fields to ticket Kafka events

Add quota, reserved, sold, maxPerUser to TicketOutboxPayload and
TicketEventData so downstream consumers receive live inventory state.
Implements design doc §9.2."
```

---

## Task 2: Remove Redisson dead code from order-service

**Files:**
- Delete: `services/order-service/src/main/java/com/ticketing/orders/config/RedissonConfig.java`
- Modify: `services/order-service/src/main/java/com/ticketing/orders/exception/GlobalExceptionHandler.java`
- Modify: `services/order-service/pom.xml`

The Redisson distributed lock was removed in CP-05 when `ReserveQuota` gRPC became the authoritative inventory gate. The `RedissonClient` bean and its exception handler are now dead code that creates a spurious connection to Redis on startup and adds Jaeger noise.

---

- [ ] **Step 1: Delete `RedissonConfig.java`**

```bash
rm services/order-service/src/main/java/com/ticketing/orders/config/RedissonConfig.java
```

- [ ] **Step 2: Remove `RedisException` handler from `GlobalExceptionHandler`**

In `services/order-service/src/main/java/com/ticketing/orders/exception/GlobalExceptionHandler.java`:

Remove the import:
```java
import org.redisson.client.RedisException;
```

Remove the handler method (the entire `@ExceptionHandler(RedisException.class)` block):
```java
@ExceptionHandler(RedisException.class)
public ResponseEntity<Map<String, Object>> handleRedisException(RedisException ex) {
    // ... entire method body
}
```

- [ ] **Step 3: Remove Redisson dependency from `pom.xml`**

In `services/order-service/pom.xml`, remove the entire Redisson dependency block (the `<dependency>` element with `<groupId>org.redisson</groupId>`). Also remove any comment referencing Redisson in the exclusions section.

After removal, verify the `pom.xml` no longer references `redisson`.

- [ ] **Step 4: Build and verify**

```bash
cd services/order-service
mvn -q clean compile
mvn -q checkstyle:check
```

Expected: BUILD SUCCESS, 0 checkstyle violations.

- [ ] **Step 5: Run order-service tests**

```bash
cd services/order-service
mvn -q test
```

Expected: BUILD SUCCESS, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/order-service/src/main/java/com/ticketing/orders/config/RedissonConfig.java \
        services/order-service/src/main/java/com/ticketing/orders/exception/GlobalExceptionHandler.java \
        services/order-service/pom.xml
git commit -m "chore(order-service): remove Redisson dead code

Redisson distributed lock was removed in CP-05. The RedissonClient bean,
its exception handler, and the pom dependency are now unused. Implements
design doc §7.4."
```

---

## Task 3: MongoDB backfill script for legacy ticket documents

**Files:**
- Create: `services/ticket-service/scripts/backfill-quota.js`

The MongoDB collection schema enforces `quota`, `reserved`, `sold`, and `maxPerUser` with `validationLevel: strict`. Any legacy document that was created before the CP-02 migration will fail on the next update. This script sets safe defaults on all documents that are missing these fields.

---

- [ ] **Step 1: Create the backfill script**

Create `services/ticket-service/scripts/backfill-quota.js`:

```javascript
// backfill-quota.js — one-time migration for ticket documents created before CP-02.
//
// Run with: mongosh <MONGO_URI> services/ticket-service/scripts/backfill-quota.js
//
// Safe to re-run: the $exists filter only touches documents that are missing
// the quota field, so already-migrated documents are unchanged.

const db = connection.getDB("ticketdb"); // adjust database name if needed
const result = db.tickets.updateMany(
  { quota: { $exists: false } },
  {
    $set: {
      quota: 1,
      reserved: 0,
      sold: 0,
      maxPerUser: 1,
    },
  }
);

print(`Backfill complete. Modified: ${result.modifiedCount}`);

// Verify: no documents should remain without quota after migration.
const remaining = db.tickets.countDocuments({ quota: { $exists: false } });
if (remaining > 0) {
  print(`WARNING: ${remaining} documents still missing quota field.`);
} else {
  print("All ticket documents now have quota fields.");
}
```

- [ ] **Step 2: Document the run command in the script header**

The file already contains the run command as a comment. Verify it matches the local MongoDB URI format used in `docker-compose.yml`.

Check:
```bash
grep -n "MONGO_URI\|mongo.*ticket" docker-compose.yml services/ticket-service/.env.example 2>/dev/null | head -5
```

If the database name differs from `ticketdb`, update the `getDB` call in the script.

- [ ] **Step 3: Verify the script runs against local Mongo**

With Docker Compose running:
```bash
MONGO_URI=$(grep -oP 'MONGO_URI=\K[^\s]+' services/ticket-service/.env.example 2>/dev/null \
  || echo "mongodb://localhost:27017")
mongosh "$MONGO_URI" services/ticket-service/scripts/backfill-quota.js
```

Expected output: `Backfill complete. Modified: N` (where N >= 0) followed by `All ticket documents now have quota fields.`

- [ ] **Step 4: Commit**

```bash
git add services/ticket-service/scripts/backfill-quota.js
git commit -m "chore(ticket-service): add one-time quota backfill script for legacy documents

Sets quota=1/reserved=0/sold=0/maxPerUser=1 on existing tickets that
predate the CP-02 quota migration. Safe to re-run. Implements design doc §8.1."
```

---

## Task 4: E2E Playwright — multi-quantity purchase and quota error cases

**Files:**
- Modify: `services/client/tests/e2e/ticketing.spec.ts`

Three new scenarios to close coverage gaps identified against design doc §14:

1. **Multi-quantity purchase** — quota=5/maxPerUser=3, buyer selects 2 units, order is created with `quantity=2`
2. **Sold-out error (409)** — quota=1, reserved after first purchase attempt, second attempt shows "sold out" error
3. **Per-user limit exceeded (422)** — quota=10/maxPerUser=1, second purchase attempt by same buyer shows "purchase limit" error

---

- [ ] **Step 1: Add `createTicketWithQuota` helper above the `test.describe("orders"` block**

In `services/client/tests/e2e/ticketing.spec.ts`, add this helper after the existing `createTicket` function:

```typescript
/**
 * Creates a GA ticket with explicit quota and maxPerUser.
 * The caller must be signed in as an organizer.
 */
async function createTicketWithQuota(
  page: Page,
  title: string,
  price: string,
  quota: number,
  maxPerUser: number
) {
  await page.goto("/tickets/new");

  const gaButton = page.getByRole("button", { name: /general admission/i });
  await gaButton.waitFor({ state: "visible", timeout: 5000 });
  await gaButton.click();

  const titleInput = page.locator("#title");
  await titleInput.waitFor({ state: "visible", timeout: 5000 });

  await fillInputAndTriggerChange(page, "#title", title);
  await fillInputAndTriggerChange(page, "#price", price);
  await fillInputAndTriggerChange(page, "#startsAt", "2025-05-11T14:00");
  await fillInputAndTriggerChange(page, "#quota", String(quota));
  await fillInputAndTriggerChange(page, "#maxPerUser", String(maxPerUser));

  const form = page.locator("form", { has: page.locator("#title") });
  await form.waitFor({ state: "visible", timeout: 5000 });

  const submitButton = form.getByRole("button", { name: /create ticket/i });
  await submitButton.waitFor({ state: "visible", timeout: 5000 });
  await submitButton.click();

  try {
    await page.waitForURL((url) => !url.pathname.endsWith("/new"), {
      timeout: 15000,
    });
  } catch {
    const alertContent = await page
      .locator('[role="alert"]')
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(`Ticket creation failed. Alert: ${alertContent}`);
  }

  return page.url();
}
```

- [ ] **Step 2: Write the multi-quantity purchase test**

Add the following test inside the existing `test.describe("GA ticket quota", ...)` block (or create a new `test.describe("GA ticket quota — purchase"` block immediately after the existing quota describe):

```typescript
test("buyer can purchase multiple units when quota allows it", async ({ page }) => {
  const sellerEmail = uniqueEmail("seller-multi-qty");
  const buyerEmail = uniqueEmail("buyer-multi-qty");

  await signupAsOrganizer(page, sellerEmail);
  const ticketUrl = await createTicketWithQuota(
    page,
    `Multi Qty ${Date.now()}`,
    "15.00",
    5,   // quota
    3    // maxPerUser
  );

  await signout(page);
  await signup(page, buyerEmail);
  await page.goto(ticketUrl);

  // Quantity stepper should appear because maxQuantity (3) > 1
  const qtyInput = page.locator('#quantity[type="number"]');
  await expect(qtyInput).toBeVisible({ timeout: 10000 });

  // Set quantity to 2
  await qtyInput.fill("2");

  await page.getByRole("button", { name: /purchase ticket/i }).click();

  // Should redirect to order detail page
  await page.waitForURL(/\/orders\/.+/, { timeout: 15000 });

  // Order summary should confirm 2 units
  await expect(page.getByText(/order summary/i)).toBeVisible();
  await expect(page.getByText(/\bqty\b.*\b2\b|\b2\b.*\bticket/i).first()).toBeVisible({
    timeout: 10000,
  });
});
```

- [ ] **Step 3: Run the multi-quantity test to confirm it passes**

Ensure Docker Compose is up and the dev server is running on port 4000:
```bash
pnpm dev --port 4000 &
cd services/client
pnpm test:e2e --grep "buyer can purchase multiple units"
```

Expected: 1 test PASSED.

- [ ] **Step 4: Write the sold-out (409) error test**

Add directly after the multi-quantity test:

```typescript
test("buyer sees sold-out error when quota is exhausted (409)", async ({ page }) => {
  const sellerEmail = uniqueEmail("seller-sold-out");
  const buyer1Email = uniqueEmail("buyer1-sold-out");
  const buyer2Email = uniqueEmail("buyer2-sold-out");

  await signupAsOrganizer(page, sellerEmail);
  const ticketUrl = await createTicketWithQuota(
    page,
    `Sold Out Test ${Date.now()}`,
    "20.00",
    1,  // quota = 1 — only one can buy
    1   // maxPerUser = 1
  );

  // Buyer 1 purchases the only unit
  await signout(page);
  await signup(page, buyer1Email);
  await page.goto(ticketUrl);
  await page.getByRole("button", { name: /purchase ticket/i }).click({ timeout: 15000 });
  await page.waitForURL(/\/orders\/.+/, { timeout: 15000 });

  // Buyer 2 tries to buy the same ticket — quota is now reserved
  await signout(page);
  await signup(page, buyer2Email);
  await page.goto(ticketUrl);

  // The purchase button may still be visible (UI does not know it is reserved until the action runs)
  await page.getByRole("button", { name: /purchase ticket/i }).click({ timeout: 15000 });

  // Should stay on the ticket page (no redirect) and show an error
  await expect(
    page.locator('[role="alert"]').filter({ hasText: /sold out|quota exceeded/i })
  ).toBeVisible({ timeout: 15000 });
});
```

- [ ] **Step 5: Write the per-user limit (422) error test**

```typescript
test("buyer sees purchase-limit error when per-user cap is hit (422)", async ({ page }) => {
  const sellerEmail = uniqueEmail("seller-pul");
  const buyerEmail = uniqueEmail("buyer-pul");

  await signupAsOrganizer(page, sellerEmail);
  const ticketUrl = await createTicketWithQuota(
    page,
    `Per User Limit Test ${Date.now()}`,
    "10.00",
    10,  // quota = 10 — plenty of inventory
    1    // maxPerUser = 1 — each buyer can only purchase once
  );

  await signout(page);
  await signup(page, buyerEmail);

  // First purchase — should succeed
  await page.goto(ticketUrl);
  await page.getByRole("button", { name: /purchase ticket/i }).click({ timeout: 15000 });
  await page.waitForURL(/\/orders\/.+/, { timeout: 15000 });

  // Second purchase attempt — per-user limit exceeded
  await page.goto(ticketUrl);
  await page.getByRole("button", { name: /purchase ticket/i }).click({ timeout: 15000 });

  // Should stay on the ticket page and show purchase limit error
  await expect(
    page.locator('[role="alert"]').filter({ hasText: /purchase limit|per.user/i })
  ).toBeVisible({ timeout: 15000 });
});
```

- [ ] **Step 6: Run the error case tests**

```bash
cd services/client
pnpm test:e2e --grep "sold-out error|purchase-limit error"
```

Expected: 2 tests PASSED.

- [ ] **Step 7: Run the full E2E suite to check for regressions**

```bash
cd services/client
pnpm test:e2e
```

Expected: all tests pass (previously 18, now 21).

- [ ] **Step 8: Commit**

```bash
git add services/client/tests/e2e/ticketing.spec.ts
git commit -m "test(client): add E2E coverage for multi-quantity purchase and quota error cases

Covers design doc §14 integration scenarios:
- Multi-unit GA purchase (quota=5/maxPerUser=3, buy 2)
- Sold-out rejection (409 → RESOURCE_EXHAUSTED)
- Per-user limit rejection (422 → FAILED_PRECONDITION)"
```

---

## Self-Review

### Spec coverage

| Design §  | Requirement | Task |
|---|---|---|
| §9.2 | `tickets.ticket.*` events carry quota/reserved/sold/maxPerUser | Task 1 |
| §7.4 | Remove Redisson from target purchase path | Task 2 |
| §8.1 | Backfill existing tickets with quota defaults | Task 3 |
| §14 | Integration tests: concurrent reservations, idempotent cancel/complete | Task 4 (partial — concurrent load tests deferred; unit/integration coverage exists in ticket-service test suite) |

### Placeholders

None — all code blocks are complete.

### Type consistency

- `TicketOutboxPayload.Quota` (int) → `TicketEventData.Quota` (int) — consistent.
- All four fields are `int` across both structs and the relay mapping.
- Java `pom.xml` removal does not introduce new types.

### Scope

The four tasks are narrow and independent. Each produces a working, testable change on its own.
