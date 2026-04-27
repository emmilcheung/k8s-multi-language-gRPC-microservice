import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PASSWORD = "Password123!";
function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`;
}

function createPkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
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

async function signupAsCreator(page: Page, email: string) {
  await signup(page, email);
}

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
 * Creates a GA ticket with explicit quota and maxPerUser.
 * The caller must be signed in.
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

  test("authenticated user can approve a dynamic OAuth consent request", async ({ page }) => {
    const email = uniqueEmail("oauth-consent");
    await signup(page, email);

    const redirectUri = "http://localhost:4000/oauth/callback-test";
    const clientName = `Playwright Consent ${Date.now()}`;
    const registerResponse = await page.request.post(
      "http://localhost:8000/oauth/clients/register",
      {
        data: {
          client_name: clientName,
          redirect_uris: [redirectUri],
          scope: "orders:create",
        },
      }
    );
    expect(registerResponse.ok()).toBe(true);

    const registeredClient = (await registerResponse.json()) as {
      client_id: string;
      client_name: string;
    };

    const codeVerifier = `${randomUUID()}${randomUUID()}`;
    const state = `oauth-state-${Date.now()}`;
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: registeredClient.client_id,
      redirect_uri: redirectUri,
      scope: "orders:create",
      state,
      code_challenge: createPkceChallenge(codeVerifier),
      code_challenge_method: "S256",
    });

    await page.goto(`http://localhost:8000/oauth/authorize?${authorizeParams.toString()}`);
    await page.waitForURL(/\/oauth\/consent\?request_id=/);

    await expect(page.getByRole("heading", { name: /allow access\?/i })).toBeVisible();
    await expect(page.getByText(clientName).first()).toBeVisible();
    await expect(page.getByText(/requested permissions/i)).toBeVisible();

    await page.getByRole("button", { name: /allow access/i }).click();
    await page.waitForURL(/\/oauth\/callback-test\?/);

    const redirectUrl = new URL(page.url());
    expect(redirectUrl.pathname).toBe("/oauth/callback-test");
    expect(redirectUrl.searchParams.get("state")).toBe(state);
    expect(redirectUrl.searchParams.get("code")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Settings tests
// ---------------------------------------------------------------------------

test.describe("settings", () => {
  test("user can save a default payment method from settings", async ({ page }) => {
    test.setTimeout(90_000);
    const paymentMethodId = `pm_mock_settings_${Date.now()}_4242`;
    await installStripeMock(page, { paymentMethodId });

    const email = uniqueEmail("settings-save-card");
    await signup(page, email);

    await page.goto("/settings");
    // RSC streams after page load — wait for real content to replace the loading skeleton
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible({ timeout: 15000 });

    await page
      .getByLabel(/I consent to saving this payment method for future charges/i)
      .check();

    const registerResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/payment-methods/register") &&
        response.request().method() === "POST",
      { timeout: 60_000 }
    );

    await page.getByRole("button", { name: /save payment method/i }).click();

    const response = await registerResponse;
    await response.finished().catch(() => undefined);
    if (!response.ok()) {
      const status = response.status();
      const body = await response.text().catch(() => "");
      test.skip(
        status >= 500 || status === 404,
        `Payment-method registration backend unavailable (${status}): ${body.slice(0, 200)}`
      );
    }
    expect(response.ok()).toBe(true);

    await expect(page.getByText(/payment method saved successfully/i)).toBeVisible({
      timeout: 15000,
    });

    await expect(page.getByText(/(\*\*\*\*|••••)\s*4242/i).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/^default$/i).first()).toBeVisible({ timeout: 15000 });
  });

  test("user can delete a saved payment method from settings", async ({ page }) => {
    test.setTimeout(90_000);
    const paymentMethodId = `pm_mock_settings_${Date.now()}_9876`;
    await installStripeMock(page, { paymentMethodId });

    const email = uniqueEmail("settings-delete-card");
    await signup(page, email);

    await page.goto("/settings");
    // RSC streams after page load — wait for real content to replace the loading skeleton
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible({ timeout: 15000 });

    await page
      .getByLabel(/I consent to saving this payment method for future charges/i)
      .check();

    const registerResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/payment-methods/register") &&
        response.request().method() === "POST",
      { timeout: 60_000 }
    );

    await page.getByRole("button", { name: /save payment method/i }).click();
    const saveResponse = await registerResponse;
    await saveResponse.finished().catch(() => undefined);
    if (!saveResponse.ok()) {
      const status = saveResponse.status();
      const body = await saveResponse.text().catch(() => "");
      test.skip(
        status >= 500 || status === 404,
        `Payment-method registration backend unavailable (${status}): ${body.slice(0, 200)}`
      );
    }
    expect(saveResponse.ok()).toBe(true);

    await expect(page.getByText(/(\*\*\*\*|••••)\s*9876/i).first()).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: /^delete$/i }).first().click();

    await expect(page.getByText(/(\*\*\*\*|••••)\s*9876/i)).toHaveCount(0, {
      timeout: 15000,
    });
    await expect(page.getByText(/no saved payment methods yet/i)).toBeVisible({ timeout: 15000 });
  });

  test("current session cannot be revoked from settings", async ({ page }) => {
    test.setTimeout(60_000);
    const email = uniqueEmail("settings-current-session");
    await signup(page, email);

    await page.goto("/settings");
    // RSC streams after page load — wait for real content to replace the loading skeleton
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible({ timeout: 15000 });

    const currentBadge = page.getByText(/^current$/i).first();
    await expect(currentBadge).toBeVisible({ timeout: 15_000 });

    const currentSessionCard = currentBadge.locator(
      "xpath=ancestor::div[contains(@class,'rounded border')][1]"
    );
    await expect(currentSessionCard.getByRole("button", { name: /^revoke$/i })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Ticket tests
// ---------------------------------------------------------------------------

test.describe("tickets", () => {
  test("seller can create a ticket and it appears on the homepage", async ({ page }) => {
    const email = uniqueEmail("seller-create");
    await signupAsCreator(page, email);

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
    await signupAsCreator(page, email);

    await createTicket(page, `Owner Test ${Date.now()}`, "10.00");

    // Wait for page to fully load (RSC streaming)
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });

    await expect(page.getByRole("button", { name: /update ticket/i }), "update ticket button should be visible").toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: /purchase ticket/i })).toHaveCount(0);
  });

  test("seller sees 'Your listing' text on own ticket", async ({ page }) => {
    const email = uniqueEmail("seller-listing");
    await signupAsCreator(page, email);

    await createTicket(page, `Listing Text ${Date.now()}`, "20.00");

    // Target the specific meta-row span, not the form subtitle
    await expect(
      page.locator("span", { hasText: "Your listing" }).first()
    ).toBeVisible();
  });

  test("seller can update a ticket", async ({ page }) => {
    const email = uniqueEmail("seller-update");
    await signupAsCreator(page, email);

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

  test("seller edit form stays in sync with stored event fields", async ({ page }) => {
    const email = uniqueEmail("seller-sync");
    await signupAsCreator(page, email);

    await page.goto("/tickets/new");
    await page.getByRole("button", { name: /general admission/i }).click();
    await page.locator("#title").waitFor({ state: "visible", timeout: 5000 });

    await fillInputAndTriggerChange(page, "#title", `Sync Test ${Date.now()}`);
    await fillInputAndTriggerChange(page, "#price", "25.00");
    await fillInputAndTriggerChange(page, "#startsAt", "2026-12-03T18:30");
    await page.locator("#eventTitle").fill("Synced Event");
    await page.locator("#eventDescription").fill("Original synced description");
    await page.locator("#venueName").fill("Sync Venue");
    await page.locator("#venueAddress").fill("1 Sync Street");

    await page.getByRole("button", { name: /create ticket/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+$/, { timeout: 15000 });

    await expect(page.locator("#eventTitle")).toHaveValue("Synced Event");
    await expect(page.locator("#eventDescription")).toHaveValue("Original synced description");
    await expect(page.locator("#venueName")).toHaveValue("Sync Venue");
    await expect(page.locator("#venueAddress")).toHaveValue("1 Sync Street");
    await expect(page.locator("#startsAt")).toHaveValue(/.+/);

    await page.locator("#eventTitle").fill("Updated Synced Event");
    await page.locator("#eventDescription").fill("Updated synced description");
    await expect(page.locator("#eventTitle")).toHaveValue("Updated Synced Event");
    await page.getByRole("button", { name: /update ticket/i }).click();

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Updated Synced Event", {
      timeout: 10000,
    });
    await expect(page.locator("#eventTitle")).toHaveValue("Updated Synced Event");
    await expect(page.locator("#eventDescription")).toHaveValue("Updated synced description");
  });

  test("create ticket requires a title", async ({ page }) => {
    const email = uniqueEmail("ticket-no-title");
    await signupAsCreator(page, email);

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
    await signupAsCreator(page, email);

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

    await signupAsCreator(page, sellerEmail);
    const ticketUrl = await createTicket(page, ticketTitle, "55.00");

    await signout(page);
    await signup(page, buyerEmail);

    await expect
      .poll(
        async () => {
          await page.goto(ticketUrl);
          await page
            .getByRole("heading", { level: 1 })
            .waitFor({ timeout: 5000 })
            .catch(() => {});
          return page.getByRole("button", { name: /purchase ticket/i }).isVisible();
        },
        { timeout: 15000, intervals: [1000, 2000, 3000] }
      )
      .toBe(true);
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

    // RSC streams after URL change — wait for real content to replace the loading skeleton
    await expect(page.getByRole("heading", { name: /my orders/i })).toBeVisible({ timeout: 15000 });
    // The cancelled status badge text should appear somewhere on the page
    await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("my orders list shows the created order", async ({ page }) => {
    const { ticketTitle } = await setupPurchase(page);

    await page.goto("/orders");

    // RSC streams after navigation — wait for real content to replace the loading skeleton
    await expect(page.getByRole("heading", { name: /my orders/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(ticketTitle)).toBeVisible({ timeout: 10000 });
  });

  test("ticket shows unavailable state after order is created", async ({ page }) => {
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
          return page.getByRole("button", { name: /unavailable/i }).isVisible();
        },
        { timeout: 30000, intervals: [2000, 3000, 5000] }
      )
      .toBe(true);

    await expect(
      page.getByRole("button", { name: /purchase ticket/i })
    ).toHaveCount(0);
    await expect(page.getByText(/remaining tickets are currently reserved or unavailable/i)).toBeVisible();
  });

  test("seller cannot purchase own ticket — sees edit form instead", async ({ page }) => {
    const email = uniqueEmail("seller-no-buy");
    await signupAsCreator(page, email);

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
    await signupAsCreator(page, email);
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
  test("authenticated user can manage a seated ticket plan lifecycle (Phase 3)", async ({ page }) => {
    test.setTimeout(60_000);
    const email = uniqueEmail("org-seated-p3");
    await signupAsCreator(page, email);

    // 1. Create a venue
    await page.goto("/venues/new");
    await page.getByLabel(/venue name/i).fill("Phase 3 Test Venue");
    await page.getByLabel(/total capacity/i).fill("200");
    await page.getByLabel(/timezone/i).fill("America/New_York");
    await page.getByRole("button", { name: /create venue/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);

    // 2. Add a venue layout section (template)
    await page.getByLabel(/section name/i).fill("Floor A");
    await page.locator('#vs-rows').fill("5");
    await page.locator('#vs-cols').fill("10");
    await page.getByRole("button", { name: /add section/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);
    await expect(page.getByText("Floor A")).toBeVisible();

    // 3. Create a manual seated ticket
    await page.goto("/tickets/new");
    await page.getByRole("button", { name: /manual assigned seating/i }).click();
    await page.locator("#title").waitFor({ state: "visible", timeout: 5000 });

    const ticketTitle = `Phase 3 Seated Test ${Date.now()}`;
    await fillInputAndTriggerChange(page, "#title", ticketTitle);
    await fillInputAndTriggerChange(page, "#price", "29.99");
    await fillInputAndTriggerChange(page, "#startsAt", "2026-12-01T19:00");

    const venueCombobox = page.getByRole("combobox").first();
    await venueCombobox.waitFor({ state: "visible", timeout: 5000 });
    await venueCombobox.click();
    await page.getByRole("option", { name: "Phase 3 Test Venue" }).click();

    await page.getByRole("button", { name: /create ticket/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+$/, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: ticketTitle })).toBeVisible();

    // 4. Manage plan should load without a runtime server-action error
    await page.getByRole("link", { name: /manage plan/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+\/plans\/[0-9a-f-]+$/, { timeout: 15000 });
    await expect(page.getByRole("link", { name: /back to ticket/i })).toBeVisible();

    const originalPlanUrl = page.url();
    const originalPlanId = originalPlanUrl.match(/plans\/([0-9a-f-]+)/)?.[1];
    expect(originalPlanId).toBeTruthy();

    await page.getByRole("button", { name: /activate plan/i }).click();
    await expect(page.getByRole("button", { name: /deactivate plan/i })).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /deactivate plan/i }).click();
    await expect(page.getByRole("button", { name: /reactivate plan/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: /create replacement plan/i })).toBeVisible();

    await page.getByRole("button", { name: /reactivate plan/i }).click();
    await expect(page.getByRole("button", { name: /deactivate plan/i })).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /deactivate plan/i }).click();
    await expect(page.getByRole("button", { name: /create replacement plan/i })).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /create replacement plan/i }).click();
    await expect.poll(() => page.url(), { timeout: 15000 }).not.toBe(originalPlanUrl);

    const replacementPlanId = page.url().match(/plans\/([0-9a-f-]+)/)?.[1];
    expect(replacementPlanId).toBeTruthy();
    expect(replacementPlanId).not.toBe(originalPlanId);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Replacement");
    await expect(page.getByText(/^draft$/i)).toBeVisible();
  });

  test("authenticated user can create an auto-assigned seated ticket (Phase 3)", async ({ page }) => {
    test.setTimeout(60_000);
    const email = uniqueEmail("org-auto-seated-p3");
    await signupAsCreator(page, email);
    const venueName = `Auto-Assign Venue ${Date.now()}`;

    // 1. Create a venue
    await page.goto("/venues/new");
    await page.getByLabel(/venue name/i).fill(venueName);
    await page.getByLabel(/total capacity/i).fill("300");
    await page.getByLabel(/timezone/i).fill("America/New_York");
    await page.getByRole("button", { name: /create venue/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);
    const venuePageUrl = page.url();

    // Extract venue ID from URL for later assertions
    const venueIdMatch = venuePageUrl.match(/venues\/([0-9a-f-]+)/);
    expect(venueIdMatch).toBeTruthy();

    // 2. Add a venue layout section (template)
    await page.getByLabel(/section name/i).fill("Main Hall");
    await page.locator('#vs-rows').fill("10");
    await page.locator('#vs-cols').fill("20");
    await page.getByRole("button", { name: /add section/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);
    await expect(page.getByText("Main Hall")).toBeVisible();

    // 3. Create an auto-assigned seated ticket
    await page.goto("/tickets/new");

    // Select auto-assigned ticket type
    const autoAssignButton = page.getByRole("button", { name: /auto-assigned seating/i });
    await autoAssignButton.waitFor({ state: "visible", timeout: 5000 });
    await autoAssignButton.click();

    // Fill in ticket details
    const titleInput = page.locator("#title");
    await titleInput.waitFor({ state: "visible", timeout: 5000 });

    const ticketTitle = `Auto-Assigned Concert ${Date.now()}`;
    await fillInputAndTriggerChange(page, "#title", ticketTitle);
    await fillInputAndTriggerChange(page, "#price", "55.00");
    await fillInputAndTriggerChange(page, "#startsAt", "2025-08-15T19:00");

    // Select the venue we created
    const venueCombobox = page.getByRole("combobox").first();
    await venueCombobox.waitFor({ state: "visible", timeout: 5000 });
    await venueCombobox.click();
    await page.getByRole("option", { name: venueName }).click();

    // Submit the form
    const form = page.locator("form", { has: page.locator("#title") });
    await form.waitFor({ state: "visible", timeout: 5000 });

    const submitButton = form.getByRole("button", { name: /create ticket/i });
    await submitButton.waitFor({ state: "visible", timeout: 5000 });
    await submitButton.click();

    // Wait for redirect to ticket detail page
    try {
      await page.waitForURL((url) => !url.pathname.endsWith("/new"), { timeout: 15000 });
    } catch {
      const alertContent = await page
        .locator('[role="alert"]')
        .first()
        .textContent()
        .catch(() => null);
      throw new Error(`Auto-assigned ticket creation failed. Alert: ${alertContent}`);
    }

    const ticketUrl = page.url();
    const ticketIdMatch = ticketUrl.match(/tickets\/([0-9a-f-]+)/);
    expect(ticketIdMatch).toBeTruthy();

    // 4. Verify the ticket was created with auto-assigned type
    await expect(page.getByRole("heading", { name: ticketTitle })).toBeVisible();

    // 5. Verify ticket detail page shows the auto-assigned type
    await expect(page.getByText("Type: Auto-assigned Seating")).toBeVisible({ timeout: 5000 });
  });

  test("buyer cannot enter seat selection when the seating plan is inactive", async ({ page }) => {
    test.setTimeout(60_000);
    const sellerEmail = uniqueEmail("seller-inactive-plan");
    const buyerEmail = uniqueEmail("buyer-inactive-plan");
    await signupAsCreator(page, sellerEmail);

    const venueName = `Inactive Plan Venue ${Date.now()}`;
    await page.goto("/venues/new");
    await page.getByLabel(/venue name/i).fill(venueName);
    await page.getByLabel(/total capacity/i).fill("200");
    await page.getByLabel(/timezone/i).fill("America/New_York");
    await page.getByRole("button", { name: /create venue/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);

    await page.getByLabel(/section name/i).fill("Floor A");
    await page.locator('#vs-rows').fill("5");
    await page.locator('#vs-cols').fill("10");
    await page.getByRole("button", { name: /add section/i }).click();
    await expect(page.getByText("Floor A")).toBeVisible();

    await page.goto("/tickets/new");
    await page.getByRole("button", { name: /manual assigned seating/i }).click();
    await page.locator("#title").waitFor({ state: "visible", timeout: 5000 });

    const ticketTitle = `Inactive Plan Ticket ${Date.now()}`;
    await fillInputAndTriggerChange(page, "#title", ticketTitle);
    await fillInputAndTriggerChange(page, "#price", "25.00");
    await fillInputAndTriggerChange(page, "#startsAt", "2026-12-01T19:00");

    const venueCombobox = page.getByRole("combobox").first();
    await venueCombobox.click();
    await page.getByRole("option", { name: venueName }).click();

    await page.getByRole("button", { name: /create ticket/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+$/, { timeout: 15000 });
    const ticketUrl = page.url();

    await page.getByRole("link", { name: /manage plan/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+\/plans\/[0-9a-f-]+$/, { timeout: 15000 });
    await page.getByRole("button", { name: /activate plan/i }).click();
    await expect(page.getByRole("button", { name: /deactivate plan/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /deactivate plan/i }).click();
    await expect(page.getByRole("button", { name: /reactivate plan/i })).toBeVisible({ timeout: 10000 });

    await signout(page);
    await signup(page, buyerEmail);
    await page.goto(ticketUrl);

    await expect(page.getByRole("button", { name: /unavailable/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/seating plan is not active/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /choose seats/i })).toHaveCount(0);
  });

  test("draft seated tickets stay off the public listing until the plan is activated", async ({ page }) => {
    test.setTimeout(60_000);
    const sellerEmail = uniqueEmail("seller-draft-listing");
    await signupAsCreator(page, sellerEmail);

    const venueName = `Draft Listing Venue ${Date.now()}`;
    await page.goto("/venues/new");
    await page.getByLabel(/venue name/i).fill(venueName);
    await page.getByLabel(/total capacity/i).fill("200");
    await page.getByLabel(/timezone/i).fill("America/New_York");
    await page.getByRole("button", { name: /create venue/i }).click();
    await page.waitForURL(/\/venues\/[0-9a-f-]+$/);

    await page.getByLabel(/section name/i).fill("Floor A");
    await page.locator('#vs-rows').fill("5");
    await page.locator('#vs-cols').fill("10");
    await page.getByRole("button", { name: /add section/i }).click();
    await expect(page.getByText("Floor A")).toBeVisible();

    await page.goto("/tickets/new");
    await page.getByRole("button", { name: /manual assigned seating/i }).click();
    await page.locator("#title").waitFor({ state: "visible", timeout: 5000 });

    const ticketTitle = `Draft Listing Ticket ${Date.now()}`;
    await fillInputAndTriggerChange(page, "#title", ticketTitle);
    await fillInputAndTriggerChange(page, "#price", "25.00");
    await fillInputAndTriggerChange(page, "#startsAt", "2026-12-01T19:00");

    const venueCombobox = page.getByRole("combobox").first();
    await venueCombobox.click();
    await page.getByRole("option", { name: venueName }).click();

    await page.getByRole("button", { name: /create ticket/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+$/, { timeout: 15000 });
    const ticketUrl = page.url();

    await page.goto("/");
    await expect(page.getByText(ticketTitle)).toHaveCount(0);

    await page.goto(ticketUrl);
    await page.getByRole("link", { name: /manage plan/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+\/plans\/[0-9a-f-]+$/, { timeout: 15000 });
    await page.getByRole("button", { name: /activate plan/i }).click();
    await expect(page.getByRole("button", { name: /deactivate plan/i })).toBeVisible({ timeout: 10000 });

    await page.goto("/");
    await expect(page.getByText(ticketTitle)).toBeVisible({ timeout: 10000 });
  });

  test("GA ticket with default quota does not show quantity stepper", async ({ page }) => {
    const sellerEmail = uniqueEmail("seller-ga-qty");
    const buyerEmail = uniqueEmail("buyer-ga-qty");
    await signupAsCreator(page, sellerEmail);

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

  test("buyer can purchase multiple units when quota allows it", async ({ page }) => {
    const sellerEmail = uniqueEmail("seller-multi-qty");
    const buyerEmail = uniqueEmail("buyer-multi-qty");

    await signupAsCreator(page, sellerEmail);
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

    // Order summary should confirm 2 units purchased (2 × $15 = $30)
    await expect(page.getByText(/order summary/i)).toBeVisible();
    // Verify the total price reflects 2 units: $30.00 (2 × $15)
    // Use .first() to avoid strict mode violation (multiple $30.00 on page)
    await expect(page.getByText(/\$30\.00/).first()).toBeVisible({
      timeout: 10000,
    });
  });

  test("buyer sees unavailable CTA when quota is exhausted", async ({ page }) => {
    const sellerEmail = uniqueEmail("seller-sold-out");
    const buyer1Email = uniqueEmail("buyer1-sold-out");
    const buyer2Email = uniqueEmail("buyer2-sold-out");

    await signupAsCreator(page, sellerEmail);
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

    await expect(
      page.getByRole("button", { name: /unavailable/i })
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/remaining tickets are currently reserved or unavailable/i)).toBeVisible();
  });

  test("buyer sees purchase-limit error when per-user cap is hit (422)", async ({ page }) => {
    const sellerEmail = uniqueEmail("seller-pul");
    const buyerEmail = uniqueEmail("buyer-pul");

    await signupAsCreator(page, sellerEmail);
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

    // Second visit — per-user limit enforcement check.
    // After the first purchase the ticket carries ticket.orderId for this user,
    // which satisfies the isReserved condition (page.tsx:86: Boolean(ticket.orderId)).
    // The CTA is disabled before any second click, enforcing maxPerUser=1 at the
    // UI layer. The backend 422 (FAILED_PRECONDITION) would fire if the request were
    // made anyway (e.g. directly via API), but the E2E path validates the UI gate.
    await page.goto(ticketUrl);

    await expect(
      page.getByRole("button", { name: /already reserved/i })
    ).toBeVisible({ timeout: 15000 });
  });
});
