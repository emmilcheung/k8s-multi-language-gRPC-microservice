import { test, expect, type Page } from "@playwright/test";
import { Kafka } from "kafkajs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PASSWORD = "Password123!";
const UUID_RE = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}@test.com`;
}

async function signup(page: Page, email: string) {
  await page.goto("/auth/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("/");
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

/** Creates a ticket as the currently signed-in user and returns the ticket URL. */
async function createTicket(page: Page, title: string, price: string) {
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Price (USD)").fill(price);
  await page.getByRole("button", { name: /create ticket/i }).click();
  // Wait for redirect to /tickets/<uuid> — must not match /tickets/new
  await page.waitForURL(
    /\/tickets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  return page.url();
}

/**
 * Bypass browser-native HTML validation on an input field so that
 * a value that would be blocked by `required`, `min`, or `pattern`
 * can still be submitted and reach the server action.
 */
async function removeNativeValidation(page: Page, selector: string) {
  await page.locator(selector).evaluate((el: HTMLInputElement) => {
    el.removeAttribute("required");
    el.removeAttribute("min");
    el.removeAttribute("pattern");
  });
}

/**
 * Publishes a payments.payment.captured CloudEvent to Kafka so that
 * order-service transitions the order to COMPLETE without needing real Stripe credentials.
 */
async function publishPaymentCaptured(orderId: string) {
  const kafka = new Kafka({
    clientId: "e2e-test",
    brokers: ["localhost:9093"], // EXTERNAL listener — reachable from the host (tests run on host)
    // Suppress noisy kafkajs logs in test output
    logLevel: 0,
  });
  const producer = kafka.producer();
  await producer.connect();

  const event = {
    specversion: "1.0",
    type: "payments.payment.captured",
    source: "e2e-test",
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: { orderId },
  };

  await producer.send({
    topic: "payments.payment.captured",
    messages: [{ key: orderId, value: JSON.stringify(event) }],
  });

  await producer.disconnect();
}



test.describe("auth", () => {
  test("signup shows navbar as logged in", async ({ page }) => {
    const email = uniqueEmail("auth-signup");
    await signup(page, email);

    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
    // Nav "Sign In" link should be absent
    await expect(
      page.locator("nav").getByRole("link", { name: "Sign In", exact: true })
    ).toHaveCount(0);
  });

  test("signout returns to signed-out state", async ({ page }) => {
    const email = uniqueEmail("auth-signout");
    await signup(page, email);

    await signout(page);

    // After signout we land on /auth/signin; check nav links are present
    await expect(
      page.locator("nav").getByRole("link", { name: "Sign In", exact: true })
    ).toBeVisible();
    await expect(
      page.locator("nav").getByRole("link", { name: "Sign Up", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(0);
  });

  test("signin with wrong password shows error", async ({ page }) => {
    const email = uniqueEmail("auth-badpwd");
    // Register first so the account exists
    await signup(page, email);
    await signout(page);

    await page.goto("/auth/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("WrongPassword999!");
    await page.getByRole("button", { name: /sign in/i }).click();

    // AuthForm renders the error in a div[role="alert"] — wait for it to have content
    await expect(
      page.locator('[role="alert"]:not([id="__next-route-announcer__"])')
    ).toBeVisible();
  });

  test("unauthenticated user is redirected from /tickets/new", async ({ page }) => {
    await page.goto("/tickets/new");
    await page.waitForURL(/\/auth\/signin/);
    expect(page.url()).toContain("/auth/signin");
  });

  test("unauthenticated user is redirected from /orders", async ({ page }) => {
    await page.goto("/orders");
    await page.waitForURL(/\/auth\/signin/);
    expect(page.url()).toContain("/auth/signin");
  });
});

// ---------------------------------------------------------------------------
// Ticket tests
// ---------------------------------------------------------------------------

test.describe("tickets", () => {
  test("seller can create a ticket and it appears on the homepage", async ({ page }) => {
    const email = uniqueEmail("seller-create");
    await signup(page, email);

    const title = `E2E Concert ${Date.now()}`;
    await createTicket(page, title, "75.00");

    // Ticket detail page reflects the data
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
    await expect(page.getByText("$75.00")).toBeVisible();

    // Ticket card appears on home page
    await page.goto("/");
    await expect(page.getByText(title)).toBeVisible();
  });

  test("seller sees edit form on own ticket, not purchase button", async ({ page }) => {
    const email = uniqueEmail("seller-owner");
    await signup(page, email);

    await createTicket(page, `Owner Test ${Date.now()}`, "10.00");

    await expect(page.getByRole("button", { name: /update ticket/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /purchase ticket/i })).toHaveCount(0);
  });

  test("seller sees 'Your listing' text on own ticket", async ({ page }) => {
    const email = uniqueEmail("seller-listing");
    await signup(page, email);

    await createTicket(page, `Listing Text ${Date.now()}`, "20.00");

    // Target the specific meta-row span, not the form subtitle
    await expect(
      page.locator("span", { hasText: "Your listing" }).first()
    ).toBeVisible();
  });

  test("seller can update a ticket", async ({ page }) => {
    const email = uniqueEmail("seller-update");
    await signup(page, email);

    const original = `Original ${Date.now()}`;
    await createTicket(page, original, "10.00");

    const updated = `Updated ${Date.now()}`;
    await page.getByLabel("Title").fill(updated);
    await page.getByLabel("Price (USD)").fill("99.99");
    await page.getByRole("button", { name: /update ticket/i }).click();

    // After update the server action redirects back to the same ticket URL;
    // wait for the h1 to reflect the new title (page re-renders via revalidatePath)
    await expect(page.getByRole("heading", { level: 1 })).toContainText(updated, {
      timeout: 10000,
    });
    await expect(page.getByText("$99.99")).toBeVisible();
  });

  test("create ticket requires a title", async ({ page }) => {
    const email = uniqueEmail("ticket-no-title");
    await signup(page, email);

    await page.goto("/tickets/new");

    // Remove the browser-native `required` so the form reaches the server action
    await removeNativeValidation(page, 'input[name="title"]');

    await page.getByLabel("Price (USD)").fill("10.00");
    await page.getByRole("button", { name: /create ticket/i }).click();

    // TicketForm renders the error in a non-announcer alert div
    const alert = page.locator('[role="alert"]:not([id="__next-route-announcer__"])');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/title/i);
  });

  test("create ticket requires a positive price", async ({ page }) => {
    const email = uniqueEmail("ticket-bad-price");
    await signup(page, email);

    await page.goto("/tickets/new");
    await page.getByLabel("Title").fill("Bad Price Test");

    // Remove browser-native min/required so 0 reaches the server action
    await removeNativeValidation(page, 'input[name="price"]');
    await page.getByLabel("Price (USD)").fill("0");

    await page.getByRole("button", { name: /create ticket/i }).click();

    const alert = page.locator('[role="alert"]:not([id="__next-route-announcer__"])');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/price/i);
  });
});

// ---------------------------------------------------------------------------
// Order tests
// ---------------------------------------------------------------------------

test.describe("orders", () => {
  /**
   * Shared fixture: seller creates ticket, buyer purchases it.
   * Returns { ticketUrl, ticketTitle }.
   */
  async function setupPurchase(page: Page) {
    const sellerEmail = uniqueEmail("seller-ord");
    const buyerEmail = uniqueEmail("buyer-ord");
    const ticketTitle = `Order E2E ${Date.now()}`;

    await signup(page, sellerEmail);
    const ticketUrl = await createTicket(page, ticketTitle, "55.00");

    await signout(page);
    await signup(page, buyerEmail);

    await page.goto(ticketUrl);
    await expect(page.getByRole("button", { name: /purchase ticket/i })).toBeVisible();
    await page.getByRole("button", { name: /purchase ticket/i }).click();
    await page.waitForURL(/\/orders\/.+/);

    return { ticketUrl, ticketTitle };
  }

  test("buyer purchases ticket — order detail shows correct data", async ({ page }) => {
    const { ticketTitle } = await setupPurchase(page);

    await expect(page.getByRole("heading", { name: /order summary/i })).toBeVisible();
    await expect(page.getByText(ticketTitle)).toBeVisible();
    // Price appears in both the Order Summary panel and the payment form — use first()
    await expect(page.getByText("$55.00").first()).toBeVisible();

    // Status badge — either "Created" or "Awaiting Payment" is valid
    await expect(
      page.locator("text=/Created|Awaiting Payment/i").first()
    ).toBeVisible();

    // Payment form (client component) — wait for hydration
    await expect(
      page.getByRole("button", { name: /pay now/i })
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("button", { name: /cancel order/i })
    ).toBeVisible();
  });

  test("buyer pays — order shows complete with success message", async ({ page }) => {
    await setupPurchase(page);

    // Extract orderId from the current URL (/orders/<uuid>)
    const orderId = page.url().split("/orders/")[1];

    // Publish payment captured event directly to Kafka — bypasses Stripe (not configured in dev)
    // Order-service consumes this and transitions the order to COMPLETE
    await publishPaymentCaptured(orderId);

    // Poll the order detail page until the status flips to complete (up to 20 s)
    await page.reload();
    await expect(page.getByText(/payment received/i)).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: /pay now/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /cancel order/i })).toHaveCount(0);
  });

  test("buyer cancels — order list shows cancelled badge", async ({ page }) => {
    await setupPurchase(page);

    // Wait for client component to hydrate before clicking
    await expect(
      page.getByRole("button", { name: /cancel order/i })
    ).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /cancel order/i }).click();
    await page.waitForURL("/orders", { timeout: 15000 });

    await expect(page.getByRole("heading", { name: /my orders/i })).toBeVisible();
    // The cancelled status badge text should appear somewhere on the page
    await expect(page.getByText(/cancelled/i).first()).toBeVisible();
  });

  test("my orders list shows the created order", async ({ page }) => {
    const { ticketTitle } = await setupPurchase(page);

    await page.goto("/orders");

    await expect(page.getByRole("heading", { name: /my orders/i })).toBeVisible();
    await expect(page.getByText(ticketTitle)).toBeVisible();
  });

  test("ticket shows 'Already Reserved' after order is created", async ({ page }) => {
    const { ticketUrl } = await setupPurchase(page);

    // The ticket detail page is server-rendered: it reads ticket.orderId from ticket-service.
    // ticket-service receives the orderId via Kafka (orders.order.created), which has variable
    // propagation latency. We poll by reloading the page until the reservation is reflected,
    // rather than relying on a single load within a fixed timeout.
    await expect
      .poll(
        async () => {
          await page.goto(ticketUrl);
          return page.getByRole("button", { name: /already reserved/i }).isVisible();
        },
        { timeout: 30000, intervals: [2000, 3000, 5000] }
      )
      .toBe(true);

    await expect(
      page.getByRole("button", { name: /purchase ticket/i })
    ).toHaveCount(0);
  });

  test("seller cannot purchase own ticket — sees edit form instead", async ({ page }) => {
    const email = uniqueEmail("seller-no-buy");
    await signup(page, email);

    await createTicket(page, `No-Buy ${Date.now()}`, "25.00");

    // Still on the ticket detail page as owner
    await expect(page.getByRole("button", { name: /update ticket/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /purchase ticket/i })).toHaveCount(0);
  });

  test("unauthenticated visitor sees sign-in link instead of purchase button", async ({ page }) => {
    // Create a ticket as a seller, then sign out
    const email = uniqueEmail("seller-unauth");
    await signup(page, email);
    const ticketUrl = await createTicket(page, `Unauth Test ${Date.now()}`, "15.00");
    await signout(page);

    // Visit as unauthenticated user
    await page.goto(ticketUrl);

    await expect(page.getByRole("link", { name: /sign in to purchase/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /purchase ticket/i })).toHaveCount(0);
  });
});
