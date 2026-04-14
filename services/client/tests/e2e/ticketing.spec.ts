import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PASSWORD = "Password123!";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`;
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

// async function signin(page: Page, email: string) {
//   await page.goto("/auth/signin");
//   await page.getByLabel("Email").fill(email);
//   await page.getByLabel("Password").fill(PASSWORD);
//   await page.getByRole("button", { name: /sign in/i }).click();
//   await page.waitForURL("/");
// }

async function signout(page: Page) {
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/\/auth\/signin/);
}

/** Creates a GA ticket as the currently signed-in user and returns the ticket URL. */
async function createTicket(page: Page, title: string, price: string) {
  await page.goto("/tickets/new");

  // Step 1: Select ticket type (General Admission button)
  const gaButton = page.getByRole("button", { name: /general admission/i });
  await gaButton.waitFor({ state: "visible", timeout: 5000 });
  await gaButton.click();

  // Step 2: Wait for form to appear and fill details
  const titleInput = page.locator('#title');
  await titleInput.waitFor({ state: "visible", timeout: 5000 });

  await fillInputAndTriggerChange(page, '#title', title);
  await fillInputAndTriggerChange(page, '#price', price);
  await fillInputAndTriggerChange(page, '#startsAt', "2025-05-11T14:00");

  // Get the ticket creation form that contains the title input.
  const form = page.locator("form", { has: page.locator('#title') });
  await form.waitFor({ state: "visible", timeout: 5000 });

  const submitButton = form.getByRole("button", { name: /create ticket/i });
  await submitButton.waitFor({ state: "visible", timeout: 5000 });

  // Click the submit button
  await submitButton.click();

  // Wait for navigation away from /tickets/new or for an error to appear
  try {
    await page.waitForURL(url => !url.pathname.endsWith('/new'), { timeout: 15000 });
  } catch {
    // If redirect failed, check for error message
    const alertContent = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    throw new Error(`Form submission failed. Alert: ${alertContent}`);
  }

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
 * Fill a React controlled input and properly trigger onChange.
 * Uses the native HTMLInputElement.prototype.value setter to bypass React's value tracking,
 * then dispatches an input event so React's synthetic onChange handler fires.
 */
async function fillInputAndTriggerChange(page: Page, selector: string, value: string) {
  const input = page.locator(selector);
  await input.evaluate((el: HTMLInputElement, val: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function installStripeMock(
  page: Page,
  options: { paymentMethodId?: string; errorMessage?: string } = {}
) {
  await page.addInitScript((mockOptions) => {
    class MockCardElement {
      private _changeHandler:
        | ((event: { error?: { message?: string }; complete: boolean }) => void)
        | null = null;

      on(
        event: string,
        handler: (event: { error?: { message?: string }; complete: boolean }) => void
      ) {
        if (event === "change") {
          this._changeHandler = handler;
        }
      }

      off() {}

      mount(container: HTMLElement | string) {
        const target =
          typeof container === "string"
            ? document.querySelector(container)
            : container;

        if (target instanceof HTMLElement) {
          target.setAttribute("data-stripe-mock", "mounted");
          target.textContent = "Mock card input";
        }

        // Simulate a completed card entry so isCardComplete becomes true
        if (this._changeHandler) {
          this._changeHandler({ complete: true });
        }
      }

      unmount() {}
    }

    Object.defineProperty(window, "Stripe", {
      configurable: true,
      writable: true,
      value: () => ({
        elements: () => ({
          create: () => new MockCardElement(),
        }),
        createPaymentMethod: async () => {
          if (mockOptions.errorMessage) {
            return { error: { message: mockOptions.errorMessage } };
          }

          return {
            paymentMethod: {
              id: mockOptions.paymentMethodId ?? "pm_mock_success",
            },
          };
        },
      }),
    });
  }, options);
}

async function clickPayNowAndWaitForSubmitPayment(page: Page) {
  const submitPaymentResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/submit-payment") &&
      response.request().method() === "POST",
    { timeout: 60_000 }
  );

  await page.getByRole("button", { name: /pay now/i }).click();

  const response = await submitPaymentResponse;
  await response.finished().catch(() => undefined);
  return response;
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

    // Wait for the heading to have content (RSC streaming completes when content appears)
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title, { timeout: 10000 });

    // Ticket detail page reflects the data
    await expect(page.getByText("$75.00").first()).toBeVisible();

    // Ticket card appears on home page.
    // Poll in case the ISR fetch cache hasn't been busted yet, and wait for the
    // "Available Tickets" heading so RSC streaming finishes before we check the title.
    await expect
      .poll(
        async () => {
          await page.goto("/");
          await page
            .getByRole("heading", { name: /available tickets/i })
            .waitFor({ timeout: 5000 })
            .catch(() => {});
          return page.getByText(title).isVisible();
        },
        { timeout: 15000, intervals: [2000, 3000] }
      )
      .toBe(true);
  });

  test("seller sees edit form on own ticket, not purchase button", async ({ page }) => {
    const email = uniqueEmail("seller-owner");
    await signup(page, email);

    await createTicket(page, `Owner Test ${Date.now()}`, "10.00");

    // Wait for page to fully load (RSC streaming)
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });

    await expect(page.getByRole("button", { name: /update ticket/i }), "update ticket button should be visible").toBeVisible({ timeout: 10000 });
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

    // Wait for page to fully load (RSC streaming)
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });

    const updated = `Updated ${Date.now()}`;
    await fillInputAndTriggerChange(page, '#title', updated);
    await fillInputAndTriggerChange(page, '#price', "99.99");
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

    // Step 1: Select ticket type (General Admission button)
    await page.getByRole("button", { name: /general admission/i }).click();

    // Step 2: Wait for form to appear
    await page.locator('#title').waitFor({ state: "visible", timeout: 5000 });

    // Remove the browser-native `required` so the form reaches the server action
    await removeNativeValidation(page, 'input[name="title"]');

    await fillInputAndTriggerChange(page, '#price', "10.00");

    // Fill required Event Date & Time field (hardcoded future date)
    await fillInputAndTriggerChange(page, '#startsAt', "2025-05-11T14:00");

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

    // Step 1: Select ticket type (General Admission button)
    await page.getByRole("button", { name: /general admission/i }).click();

    // Step 2: Wait for form to appear
    await page.locator('#title').waitFor({ state: "visible", timeout: 5000 });
    await fillInputAndTriggerChange(page, '#title', "Bad Price Test");

    // Remove browser-native min/required so 0 reaches the server action
    await removeNativeValidation(page, 'input[name="price"]');
    await fillInputAndTriggerChange(page, '#price', "0");

    // Fill required Event Date & Time field (hardcoded future date)
    await fillInputAndTriggerChange(page, '#startsAt', "2025-05-11T14:00");

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

  test("buyer pays through mocked Stripe checkout — order shows complete with success message", async ({ page }) => {
    test.setTimeout(90_000);
    await installStripeMock(page, { paymentMethodId: "pm_mock_success" });
    await setupPurchase(page);

    await expect(page.locator("#card-element")).toHaveAttribute("data-stripe-mock", "mounted", {
      timeout: 10000,
    });
    await expect(page.getByRole("button", { name: /pay now/i })).toBeEnabled();

    // In CI the App Router route can take a while to compile on first use.
    // Wait for the submit-payment request to finish before any reload-based polling,
    // otherwise the reload can abort the in-flight request and leave the order unchanged.
    const submitPaymentResponse = await clickPayNowAndWaitForSubmitPayment(page);
    expect(submitPaymentResponse.ok()).toBe(true);

    await page
      .getByRole("heading", { name: /order summary/i })
      .waitFor({ state: "visible", timeout: 20000 });

    // Poll for the Kafka-driven order status transition to "complete".
    await expect
      .poll(
        async () => {
          await page.reload({ waitUntil: "domcontentloaded" });
          // Same heading guard inside the poll: ensures we're reading real
          // content (not the loading.tsx skeleton) before checking the status.
          const hasRealContent = await page
            .getByRole("heading", { name: /order summary/i })
            .waitFor({ state: "visible", timeout: 10000 })
            .then(() => true)
            .catch(() => false);
          if (!hasRealContent) return false;
          return page.getByText(/payment received/i).isVisible();
        },
        { timeout: 40000, intervals: [2000, 4000] }
      )
      .toBe(true);

    await expect(page.getByRole("button", { name: /pay now/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /cancel order/i })).toHaveCount(0);
  });

  test("buyer sees a payment error when mocked Stripe checkout is declined", async ({ page }) => {
    test.setTimeout(90_000);
    await installStripeMock(page, { paymentMethodId: "pm_mock_declined" });
    await setupPurchase(page);

    await expect(page.locator("#card-element")).toHaveAttribute("data-stripe-mock", "mounted", {
      timeout: 10000,
    });
    await expect(page.getByRole("button", { name: /pay now/i })).toBeEnabled();

    const submitPaymentResponse = await clickPayNowAndWaitForSubmitPayment(page);
    expect(submitPaymentResponse.ok()).toBe(false);

    await expect(
      page.locator('[role="alert"]:not([id="__next-route-announcer__"])')
    ).toContainText(/mock payment declined/i, {
      timeout: 10000,
    });

    await expect
      .poll(
        async () => {
          await page.reload();
          await page
            .getByRole("heading", { name: /order summary|order cancelled/i })
            .first()
            .waitFor({ timeout: 10000 })
            .catch(() => {});
          return page.getByText(/order cancelled/i).isVisible();
        },
        { timeout: 45000, intervals: [2000, 3000, 5000] }
      )
      .toBe(true);

    await expect(page.getByRole("button", { name: /pay now/i })).toHaveCount(0);
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

    // The ticket detail page is server-rendered: it reads ticket.reserved from ticket-service.
    // ticket-service receives the reservation via Kafka (orders.order.created), which has variable
    // propagation latency. We poll by reloading the page until the reservation is reflected,
    // rather than relying on a single load within a fixed timeout.
    //
    // IMPORTANT: Next.js App Router streams RSC content after the initial HTML.
    // page.goto() resolves (load event) before streaming completes — the loading.tsx
    // skeleton is served first, and the real content (with the button) arrives later.
    // We must wait for the h1 heading (absent in the skeleton) before checking the button.
    await expect
      .poll(
        async () => {
          await page.goto(ticketUrl);
          // Wait for streaming RSC content to replace the loading skeleton.
          // The h1 heading only appears in the real page, not the skeleton.
          await page
            .getByRole("heading", { level: 1 })
            .waitFor({ timeout: 5000 })
            .catch(() => {});
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

    // Wait for page to fully load (RSC streaming)
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });

    // Still on the ticket detail page as owner
    await expect(page.getByRole("button", { name: /update ticket/i }), "update ticket button should be visible").toBeVisible({ timeout: 10000 });
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

// ---------------------------------------------------------------------------
// Seating plan (CP-14) tests
// ---------------------------------------------------------------------------

test.describe("seating plan", () => {
  test("organizer sees seating plan panel on own ticket", async ({ page }) => {
    const email = uniqueEmail("org-seatplan");
    await signup(page, email);

    await createTicket(page, `Seating Plan Test ${Date.now()}`, "50.00");

    // AttachSeatingPlanForm is only rendered for the ticket owner.
    // With no active plans created yet the organiser is guided to the venue manager.
    await expect(page.getByText("Seating Plan").first()).toBeVisible();
    await expect(page.getByText(/no active seating plans/i)).toBeVisible();
    await expect(
      page.getByRole("link", { name: /go to venue manager/i })
    ).toBeVisible();
  });

  test("organizer can create a plan and attach it to a ticket", async ({ page }) => {
    const email = uniqueEmail("org-attach");
    await signup(page, email);

    // 1. Create a venue
    await page.goto("/venues/new");
    await page.getByLabel(/venue name/i).fill("Attach Test Venue");
    await page.getByLabel(/total capacity/i).fill("200");
    await page.getByLabel(/timezone/i).fill("America/New_York");
    await page.getByRole("button", { name: /create venue/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);

    // 2. Add a venue layout section
    await page.getByLabel(/section name/i).fill("Floor A");
    // rowCount and columnCount fields appear when type=seated (the default)
    await page.locator('#vs-rows').fill("5");
    await page.locator('#vs-cols').fill("10");
    await page.getByRole("button", { name: /add section/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);
    await expect(page.getByText("Floor A")).toBeVisible();

    // 3. Create a seating plan for this venue
    await page.getByRole("link", { name: /new plan/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+\/plans\/new$/);
    await page.getByLabel(/plan name/i).fill("April Show Plan");
    await page.getByRole("button", { name: /create seating plan/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+\/plans\/[0-9a-f-]+$/);

    // Plan auto-provisions sections from the venue template
    await expect(page.getByText("Floor A")).toBeVisible();

    // 3b. Activate the plan so it appears in the attach dropdown
    await page.getByRole("button", { name: /activate/i }).click();
    await expect(page.getByText(/active/i).first()).toBeVisible({ timeout: 10000 });

    // 4. Create a ticket and navigate to its detail page
    await createTicket(page, `Attach Test ${Date.now()}`, "55.00");

    // 5. The seating plan panel now shows the active plan in the dropdown
    await expect(page.getByText("Seating Plan").first()).toBeVisible();
    await expect(page.locator('#planId')).toBeVisible();

    // 6. Select the plan and attach it (there should be exactly one non-disabled option)
    await page.locator('#planId').selectOption({ index: 1 });
    await page.getByRole("button", { name: /attach seating plan/i }).click();

    // 7. After redirect, the panel shows the attached plan ID and a Detach button
    await expect(page.getByText(/attached plan/i)).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("button", { name: /detach seating plan/i })
    ).toBeVisible();
  });

  test("GA ticket with default quota does not show quantity stepper", async ({ page }) => {
    const sellerEmail = uniqueEmail("seller-ga-qty");
    const buyerEmail = uniqueEmail("buyer-ga-qty");
    await signup(page, sellerEmail);

    const ticketUrl = await createTicket(page, `GA No Stepper ${Date.now()}`, "20.00");

    await signout(page);
    await signup(page, buyerEmail);

    await page.goto(ticketUrl);

    // The "Purchase Ticket" button should be visible for the buyer
    await expect(page.getByRole("button", { name: /purchase ticket/i })).toBeVisible();
    // The quantity stepper input is only rendered when maxQuantity > 1 (quota > 1).
    // A freshly created ticket has quota=1, so the stepper must be absent.
    await expect(page.locator('#quantity[type="number"]')).toHaveCount(0);
  });
});
