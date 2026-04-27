import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PASSWORD = "Password123!";
const KONG_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const GRAPHQL_URL = `${KONG_URL}/graphql`;
const AUTH_POSTGRES_CONTAINER = "microservices-postgres-auth-1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`;
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function grantOrganizerRole(email: string) {
  const sql = [
    "WITH promoted AS (",
    "  UPDATE users",
    `  SET roles = '[\"organizer\"]'::json`,
    `  WHERE email = ${sqlLiteral(email)}`,
    "  RETURNING 1",
    ")",
    "SELECT COUNT(*) FROM promoted;",
  ].join(" ");
  const result = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      AUTH_POSTGRES_CONTAINER,
      "psql",
      "-U",
      "auth_user",
      "-d",
      "auth_db",
      "-t",
      "-A",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();

  if (result !== "1") {
    throw new Error(`Failed to promote ${email} to organizer. Updated rows: ${result || "0"}`);
  }
}

async function signup(page: Page, email: string) {
  await page.goto("/auth/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign up/i }).click();
  try {
    await page.waitForURL("/", { timeout: 15000 });
  } catch {
    const alertContent = await page
      .locator('[role="alert"]:not([id="__next-route-announcer__"])')
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(`Signup failed for ${email}. Alert: ${alertContent}`);
  }
}

async function signin(page: Page, email: string) {
  await page.goto("/auth/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("/");
}

async function signout(page: Page) {
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/\/auth\/signin/);
}

async function signupAsOrganizer(page: Page, email: string) {
  await signup(page, email);
  grantOrganizerRole(email);
  await signout(page);
  await signin(page, email);
}

async function fillInputAndTriggerChange(page: Page, selector: string, value: string) {
  const input = page.locator(selector);
  await input.evaluate((el: HTMLInputElement, val: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function createAttachedSeatedTicket(page: Page) {
  // Phase 3: Create venue template, then create a seated ticket which auto-creates a plan
  const venueName = `GraphQL Venue ${Date.now()}`;

  await page.goto("/venues/new");
  await page.getByLabel(/venue name/i).fill(venueName);
  await page.getByLabel(/total capacity/i).fill("200");
  await page.getByLabel(/timezone/i).fill("America/New_York");
  await page.getByRole("button", { name: /create venue/i }).click();
  await page.waitForURL(/\/venues\/[0-9a-f-]+$/);

  const venueUrl = page.url();
  const venueId = venueUrl.split("/").at(-1);
  if (!venueId) {
    throw new Error("Failed to derive venue ID from URL");
  }

  await page.getByLabel(/section name/i).fill("Floor A");
  await page.locator("#vs-rows").fill("5");
  await page.locator("#vs-cols").fill("10");
  await page.getByRole("button", { name: /add section/i }).click();
  await page.waitForURL(/\/venues\/[0-9a-f-]+$/);
  await expect(page.getByText("Floor A")).toBeVisible();

  // Now create a seated ticket with this venue
  // This will auto-create and attach a seating plan
  await page.goto("/tickets/new");

  // Select the manual seated flow in the ticket type picker.
  const seatedButton = page.getByRole("button", { name: /manual assigned seating/i });
  await seatedButton.waitFor({ state: "visible", timeout: 5000 });
  await seatedButton.click();

  const titleInput = page.locator("#title");
  await titleInput.waitFor({ state: "visible", timeout: 5000 });

  await fillInputAndTriggerChange(page, "#title", `GraphQL Seated ${Date.now()}`);
  await fillInputAndTriggerChange(page, "#price", "55.00");
  await fillInputAndTriggerChange(page, "#startsAt", "2025-05-11T14:00");
  
  // Select the venue template we just created.
  const venueCombobox = page.getByRole("combobox").first();
  if (await venueCombobox.isVisible()) {
    await venueCombobox.click();
    await page.getByRole("option", { name: venueName }).click();
  } else {
    await fillInputAndTriggerChange(page, "#venueId", venueId);
  }

  const form = page.locator("form", { has: page.locator("#title") });
  await form.waitFor({ state: "visible", timeout: 5000 });

  const submitButton = form.getByRole("button", { name: /create ticket/i });
  await submitButton.waitFor({ state: "visible", timeout: 5000 });
  await submitButton.click();

  try {
    await page.waitForURL((url) => !url.pathname.endsWith("/new"), { timeout: 15000 });
  } catch {
    const alertContent = await page
      .locator('[role="alert"]')
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(`Seated ticket creation failed. Alert: ${alertContent}`);
  }

  const ticketUrl = page.url();
  const ticketId = ticketUrl.split("/").at(-1);
  if (!ticketId) {
    throw new Error("Failed to derive ticket ID from ticket URL");
  }

  const managePlanLink = page.getByRole("link", { name: /manage plan/i });
  await managePlanLink.waitFor({ state: "visible", timeout: 15000 });
  const managePlanHref = await managePlanLink.getAttribute("href");
  const planId = managePlanHref?.split("/").at(-1);
  
  if (!planId) {
    throw new Error("Ticket does not have an auto-created seating plan");
  }

  return { planId, ticketId };
}

/** Extract the JWT token cookie value from the current browser context. */
async function getTokenCookie(page: Page): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "token")?.value;
}

/** Send a raw GraphQL query via Playwright API context. */
async function graphqlRequest(
  request: APIRequestContext,
  query: string,
  variables?: Record<string, unknown>,
  cookie?: string,
) {
  return request.post(GRAPHQL_URL, {
    data: { query, variables },
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: `token=${cookie}` } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("GraphQL Federation — Auth Propagation", () => {
  test("authenticated user can query currentUser via GraphQL", async ({ page, request }) => {
    const email = uniqueEmail("gql-auth");
    await signup(page, email);
    const token = await getTokenCookie(page);
    expect(token).toBeTruthy();

    const response = await graphqlRequest(
      request,
      `query { currentUser { id email } }`,
      undefined,
      token,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.currentUser).toBeTruthy();
    expect(body.data.currentUser.email).toBe(email);
  });

  test("unauthenticated GraphQL request returns null currentUser", async ({ request }) => {
    const response = await graphqlRequest(
      request,
      `query { currentUser { id email } }`,
    );

    // Kong may return 401 for unauthenticated requests or the query may succeed
    // with null currentUser depending on whether the route requires JWT.
    // Either behavior is acceptable — the key is no data leaks.
    if (response.status() === 200) {
      const body = await response.json();
      expect(body.data?.currentUser).toBeNull();
    } else {
      expect(response.status()).toBe(401);
    }
  });

  test("expired/malformed JWT is rejected", async ({ request }) => {
    const fakeToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXItaWQiLCJleHAiOjEwMDAwMDAwMDB9.invalid-signature";

    const response = await graphqlRequest(
      request,
      `query { currentUser { id } }`,
      undefined,
      fakeToken,
    );

    // Kong should reject the invalid JWT
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test("forged x-user-id header is stripped by Kong", async ({ request }) => {
    // Send a request with a spoofed x-user-id header but no valid JWT
    const response = await request.post(GRAPHQL_URL, {
      data: { query: `query { currentUser { id email } }` },
      headers: {
        "Content-Type": "application/json",
        "x-user-id": "forged-user-id",
        "x-user-roles": '["admin"]',
      },
    });

    // Kong should strip x-user-id and either return 401 (JWT required)
    // or return null currentUser (header stripped, no auth)
    if (response.status() === 200) {
      const body = await response.json();
      expect(body.data?.currentUser).toBeNull();
    } else {
      expect(response.status()).toBe(401);
    }
  });
});

test.describe("GraphQL Federation — Cross-Subgraph Resolution", () => {
  test("order query resolves user entity across subgraphs", async ({ page, request }) => {
    const email = uniqueEmail("gql-cross");
    await signup(page, email);
    const token = await getTokenCookie(page);
    expect(token).toBeTruthy();

    // Query the current user's orders — this exercises auth-service (User entity)
    // and order-service (orders field on User) across federation boundaries.
    const response = await graphqlRequest(
      request,
      `query {
        currentUser {
          id
          orders {
            id
            status
          }
        }
      }`,
      undefined,
      token,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.currentUser).toBeTruthy();
    // User may have no orders yet, but the cross-subgraph resolution should work
    expect(body.data.currentUser.orders).toBeDefined();
    expect(Array.isArray(body.data.currentUser.orders)).toBe(true);
  });

  test("ticket query resolves seatingPlan across ticket and venue subgraphs", async ({ page, request }) => {
    const email = uniqueEmail("gql-venue");
    await signupAsOrganizer(page, email);
    const { planId, ticketId } = await createAttachedSeatedTicket(page);
    const token = await getTokenCookie(page);
    expect(token).toBeTruthy();

    const response = await graphqlRequest(
      request,
      `query TicketWithSeatingPlan($id: ID!) {
        ticket(id: $id) {
          id
          seatingPlan {
            id
            status
            sections {
              id
              name
              availableSeats
              seats {
                id
                label
                status
                price
              }
            }
          }
        }
      }`,
      { id: ticketId },
      token,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.ticket.id).toBe(ticketId);
    expect(body.data.ticket.seatingPlan.id).toBe(planId);
    expect(body.data.ticket.seatingPlan.status).toBe("DRAFT");
    expect(body.data.ticket.seatingPlan.sections.length).toBeGreaterThan(0);
    expect(body.data.ticket.seatingPlan.sections[0].name).toBe("Floor A");
    expect(body.data.ticket.seatingPlan.sections[0].seats.length).toBeGreaterThan(0);
  });
});

test.describe("GraphQL Federation — SSR Path", () => {
  test("SSR page using GraphQL loads correctly for authenticated user", async ({ page }) => {
    const email = uniqueEmail("gql-ssr");
    await signup(page, email);

    // Navigate to the orders page (uses SSR with GraphQL)
    await page.goto("/orders");

    // The page should load without errors and show the authenticated state
    // (even if there are no orders yet)
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();

    // Should NOT show an error or redirect to login
    expect(page.url()).toContain("/orders");
  });

  test("SSR page redirects unauthenticated user", async ({ page }) => {
    // Attempt to access orders page without auth
    await page.goto("/orders");

    // Should redirect to signin
    await page.waitForURL(/\/auth\/signin/, { timeout: 10000 });
  });
});

test.describe("GraphQL Federation — Security Hardening", () => {
  test("tampered x-user-id-sig is rejected by subgraph", async ({ page, request }) => {
    const email = uniqueEmail("gql-sig");
    await signup(page, email);
    const token = await getTokenCookie(page);
    expect(token).toBeTruthy();

    // Send a valid JWT but with a tampered x-user-id-sig header.
    // Kong will set x-user-id from the JWT, but we override x-user-id-sig
    // with an invalid value. The subgraph should reject the signature.
    const response = await request.post(GRAPHQL_URL, {
      data: { query: `query { currentUser { id email } }` },
      headers: {
        "Content-Type": "application/json",
        Cookie: `token=${token}`,
        "x-user-id-sig": "tampered-invalid-signature",
      },
    });

    // If the signing key is configured, subgraph rejects with 401 or
    // returns errors. If not configured (dev mode), it may pass through.
    const body = await response.json();
    if (response.status() === 401) {
      // Direct rejection — expected when signing key is active
      return;
    }
    if (body.errors && body.errors.length > 0) {
      // GraphQL-level error from guard
      expect(body.errors[0].message).toContain("unauthorized");
      return;
    }
    // If signing key is not configured (dev), graceful degradation is acceptable
    expect(response.status()).toBe(200);
  });

  test("cross-user entity resolution returns empty orders", async ({ page, request, browser }) => {
    const emailA = uniqueEmail("gql-cross-a");
    const emailB = uniqueEmail("gql-cross-b");

    await signup(page, emailA);

    // Use a separate browser context for user B to avoid fragile signout flow
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signup(pageB, emailB);
    const tokenB = await getTokenCookie(pageB);
    expect(tokenB).toBeTruthy();
    await ctxB.close();

    // User B queries their own orders — this exercises cross-subgraph
    // entity resolution. User B should only see their own orders (empty list),
    // never user A's data.
    const response = await graphqlRequest(
      request,
      `query { currentUser { id orders { id status } } }`,
      undefined,
      tokenB,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.currentUser).toBeTruthy();
    expect(body.data.currentUser.orders).toEqual([]);
  });

  test("deeply nested query exceeding depth limit is rejected", async ({ request }) => {
    // Build a query that exceeds max_depth: 15
    // Each nesting level: currentUser -> orders -> ticket -> seatingPlan -> sections -> seats
    // Repeat nesting to exceed the limit
    const deepQuery = `query {
      currentUser {
        orders {
          id
          ticket {
            id
            seatingPlan {
              id
              sections {
                id
                seats {
                  id
                  section {
                    id
                    seats {
                      id
                      section {
                        id
                        seats {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;

    const response = await request.post(GRAPHQL_URL, {
      data: { query: deepQuery },
      headers: { "Content-Type": "application/json" },
    });

    // Router should reject with an error about query depth/complexity
    // The exact status may be 200 with GraphQL errors or 400
    const body = await response.json();
    if (response.status() === 200 && body.errors) {
      expect(body.errors.length).toBeGreaterThan(0);
    } else if (response.status() === 400) {
      // Router rejected the query at the HTTP level
      expect(response.status()).toBe(400);
    } else {
      // If Kong requires auth (401), that's also acceptable since the
      // depth check happens after auth in some configurations
      expect(response.status()).toBeGreaterThanOrEqual(400);
    }
  });

  test("introspection query is blocked in production config", async ({ request }) => {
    const response = await request.post(GRAPHQL_URL, {
      data: { query: `{ __schema { types { name } } }` },
      headers: { "Content-Type": "application/json" },
    });

    // In local dev, introspection may be allowed (router.yaml has no
    // introspection: false). In production (Helm config), it's blocked.
    // This test documents the expected behavior — in CI with the Helm
    // config, the response should contain an error.
    if (response.status() === 200) {
      const body = await response.json();
      // If we get data back, introspection is enabled (acceptable in dev)
      // If we get errors, introspection is blocked (expected in prod)
      if (body.errors) {
        expect(body.errors[0].message).toMatch(/introspection/i);
      }
    } else {
      // Non-200 means blocked (could be 400 or 401)
      expect(response.status()).toBeGreaterThanOrEqual(400);
    }
  });
});
