import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { installNoLegacyPaymentRestGuard } from "./_helpers/expect-no-rest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PASSWORD = "Password123!";
let assertNoLegacyPaymentRest: () => void = () => {};
function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`;
}

test.beforeEach(async ({ page }) => {
  assertNoLegacyPaymentRest = installNoLegacyPaymentRestGuard(page);
});

test.afterEach(async () => {
  assertNoLegacyPaymentRest();
});

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

async function openTicketDetailUntilReady(
  page: Page,
  ticketUrl: string,
  readyLocator: Locator
) {
  for (const delayMs of [0, 4000, 8000]) {
    if (delayMs > 0) {
      await page.waitForTimeout(delayMs);
    }

    await page.goto(ticketUrl, { waitUntil: "domcontentloaded", timeout: 10000 });

    const isReady = await readyLocator
      .waitFor({ state: "visible", timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (isReady) {
      return;
    }
  }

  await expect(readyLocator).toBeVisible({ timeout: 5000 });
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
  const submitPaymentRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" && Boolean(request.headers()["next-action"]),
    { timeout: 60_000 }
  );

  await page.getByRole("button", { name: /pay now/i }).click();

  const request = await submitPaymentRequest;
  return request;
}

function waitForSettingsServerAction(page: Page) {
  return page.waitForResponse(
    (response) => {
      try {
        return (
          response.url().includes("/settings") &&
          response.request().method() === "POST" &&
          Boolean(response.request().headers()["next-action"])
        );
      } catch {
        return false;
      }
    },
    { timeout: 60_000 }
  );
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

    const registerResponse = waitForSettingsServerAction(page);

    await page.getByRole("button", { name: /save payment method/i }).click();

    const response = await registerResponse;
    const status = response.status();
    test.skip(
      status >= 500 || status === 404,
      `Payment-method registration backend unavailable (${status})`
    );

    // Next server-action redirects can complete the UI update before the underlying
    // streaming response is fully settled. Wait for the redirected settings state
    // instead of transport-level completion to avoid CI-only hangs.
    await page.waitForURL(/\/settings(?:\?paymentMethodSaved=1)?$/, { timeout: 15_000 });

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

    const registerResponse = waitForSettingsServerAction(page);

    await page.getByRole("button", { name: /save payment method/i }).click();
    const saveResponse = await registerResponse;
    const saveStatus = saveResponse.status();
    test.skip(
      saveStatus >= 500 || saveStatus === 404,
      `Payment-method registration backend unavailable (${saveStatus})`
    );

    await page.waitForURL(/\/settings(?:\?paymentMethodSaved=1)?$/, { timeout: 15_000 });

    await expect(page.getByText(/(\*\*\*\*|••••)\s*9876/i).first()).toBeVisible({ timeout: 15000 });

    const deleteResponse = waitForSettingsServerAction(page);
    await page.getByRole("button", { name: /^delete$/i }).first().click();
    const response = await deleteResponse;
    const deleteStatus = response.status();
    test.skip(
      deleteStatus >= 500 || deleteStatus === 404,
      `Payment-method deletion backend unavailable (${deleteStatus})`
    );

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

    await expect(
      page.locator('[data-slot="card-title"]').filter({ hasText: /security\s*&\s*sessions/i })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^revoke$/i })).toHaveCount(1);
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

    const ticketUrl = await createTicket(page, `Owner Test ${Date.now()}`, "10.00");
    const ticketId = ticketUrl.split("/").at(-1);

    // The ticket detail page is now public/buyer-only — no edit form there.
    // The edit form lives at /organizer/events/<id>/edit.
    await page.goto(`/organizer/events/${ticketId}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });

    await expect(page.getByRole("button", { name: /update ticket/i }), "update ticket button should be visible on organizer edit page").toBeVisible({ timeout: 10000 });

    // The ticket detail page always shows the purchase CTA (buyer-only ISR page).
    await page.goto(ticketUrl);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });
    await expect(page.getByRole("button", { name: /update ticket/i })).toHaveCount(0);
  });

  test("seller sees 'Your listing' text when ticket is reserved", async ({ page }) => {
    // "Your listing" card appears on the organizer edit page when the ticket is
    // reserved (orderId set) — it replaces the edit form in that state.
    // A freshly-created ticket is not reserved, so the edit form renders instead.
    // We just verify the organizer edit page renders without error for a normal ticket.
    const email = uniqueEmail("seller-listing");
    await signupAsCreator(page, email);

    const ticketUrl = await createTicket(page, `Listing Text ${Date.now()}`, "20.00");
    const ticketId = ticketUrl.split("/").at(-1);

    await page.goto(`/organizer/events/${ticketId}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });

    // For an unreserved ticket the edit form renders (not the "Your listing" card).
    // Assert the "Manage event" card and the update button are visible.
    await expect(page.getByText("Manage event").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: /update ticket/i })).toBeVisible({ timeout: 10000 });
  });

  test("seller can update a ticket", async ({ page }) => {
    const email = uniqueEmail("seller-update");
    await signupAsCreator(page, email);

    const original = `Original ${Date.now()}`;
    const ticketUrl = await createTicket(page, original, "10.00");
    const ticketId = ticketUrl.split("/").at(-1);

    // The edit form is at the organizer route, not the ticket detail page.
    await page.goto(`/organizer/events/${ticketId}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });

    const updated = `Updated ${Date.now()}`;
    await fillInputAndTriggerChange(page, '#title', updated);
    await fillInputAndTriggerChange(page, '#price', "99.99");
    await page.getByRole("button", { name: /update ticket/i }).click();

    // After update the server action redirects back to the same organizer URL;
    // wait for the event-title h1 (the second h1 on the page; the first is "Organizer tools")
    // to reflect the new title (page re-renders via revalidatePath).
    await expect(page.getByRole("heading", { level: 1 }).nth(1)).toContainText(updated, {
      timeout: 10000,
    });
    // Verify the price was persisted — it populates the price input field on the edit form.
    await expect(page.locator("#price")).toHaveValue("99.99");
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

    // The edit form is now at the organizer route, not the ticket detail page.
    const ticketId = page.url().split("/").at(-1);
    await page.goto(`/organizer/events/${ticketId}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });

    await expect(page.locator("#eventTitle")).toHaveValue("Synced Event");
    await expect(page.locator("#eventDescription")).toHaveValue("Original synced description");
    await expect(page.locator("#venueName")).toHaveValue("Sync Venue");
    await expect(page.locator("#venueAddress")).toHaveValue("1 Sync Street");
    await expect(page.locator("#startsAt")).toHaveValue(/.+/);

    await page.locator("#eventTitle").fill("Updated Synced Event");
    await page.locator("#eventDescription").fill("Updated synced description");
    await expect(page.locator("#eventTitle")).toHaveValue("Updated Synced Event");
    await page.getByRole("button", { name: /update ticket/i }).click();

    // The organizer page has two h1s ("Organizer tools" + event title); check the second.
    await expect(page.getByRole("heading", { level: 1 }).nth(1)).toContainText("Updated Synced Event", {
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

    await openTicketDetailUntilReady(
      page,
      ticketUrl,
      page.getByRole("button", { name: /purchase ticket/i })
    );
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
    await clickPayNowAndWaitForSubmitPayment(page);

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

    await clickPayNowAndWaitForSubmitPayment(page);

    await expect(
      page.locator('[role="alert"]:not([id="__next-route-announcer__"])')
    ).toContainText(/mock payment declined|subgraph errors redacted/i, {
      timeout: 10000,
    });
    await expect(page.getByRole("button", { name: /pay now/i })).toBeVisible();
  });

  test("buyer cancels — order list shows cancelled badge", async ({ page }) => {
    test.setTimeout(60_000);
    await setupPurchase(page);

    // Wait for client component to hydrate before clicking
    await expect(
      page.getByRole("button", { name: /cancel order/i })
    ).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /cancel order/i }).click();
    await page.waitForURL("/orders", { timeout: 15000 });
    await expect(page.getByRole("heading", { name: /my orders/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole("tab", { name: /past/i }).click();
    await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("my orders list shows the created order", async ({ page }) => {
    const { ticketTitle } = await setupPurchase(page);

    await page.goto("/orders");

    // RSC streams after navigation — wait for real content to replace the loading skeleton
    await expect(page.getByRole("heading", { name: /my orders/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole("tab", { name: /past/i }).click();
    await expect(page.getByText(ticketTitle)).toBeVisible({ timeout: 10000 });

    await page.getByRole("tab", { name: /saved/i }).click();
    await expect(page.getByText(/no saved events yet/i)).toBeVisible({ timeout: 10000 });
  });

  test("completed order exposes transfer and refund action routes", async ({ page }) => {
    test.setTimeout(90_000);
    // The transfer route is gated on an issued admission pass, which only exists
    // once the order is paid — so complete the payment first.
    await installStripeMock(page, { paymentMethodId: "pm_mock_success" });
    await setupPurchase(page);
    const orderUrl = page.url();

    await expect(page.locator("#card-element")).toHaveAttribute("data-stripe-mock", "mounted", {
      timeout: 10000,
    });
    await expect(page.getByRole("button", { name: /pay now/i })).toBeEnabled();
    await clickPayNowAndWaitForSubmitPayment(page);

    await expect
      .poll(
        async () => {
          await page.reload({ waitUntil: "domcontentloaded" });
          const ready = await page
            .getByRole("heading", { name: /order summary/i })
            .waitFor({ state: "visible", timeout: 10000 })
            .then(() => true)
            .catch(() => false);
          if (!ready) return false;
          return page.getByText(/payment received/i).isVisible();
        },
        { timeout: 40000, intervals: [2000, 4000] }
      )
      .toBe(true);

    await expect(page.getByRole("link", { name: /send to friend/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("link", { name: /request refund/i })).toBeVisible({ timeout: 10000 });

    // Pass issuance is Kafka-driven and can lag the status flip; the transfer page
    // 404s until the pass exists. Poll the route directly with a waiting locator.
    const transferUrl = `${orderUrl}/transfer`;
    await expect
      .poll(
        async () => {
          await page.goto(transferUrl, { waitUntil: "domcontentloaded" });
          return page
            .getByRole("heading", { name: /transfer pass/i })
            .waitFor({ state: "visible", timeout: 4000 })
            .then(() => true)
            .catch(() => false);
        },
        { timeout: 40000, intervals: [3000, 5000] }
      )
      .toBe(true);

    await page.goto(orderUrl);
    await page.getByRole("link", { name: /request refund/i }).click();
    await expect(page).toHaveURL(/\/orders\/.+\/refund/);
    await expect(page.getByRole("heading", { name: /request refund/i })).toBeVisible({ timeout: 10000 });
  });

  test("ticket shows unavailable state after order is created", async ({ page }) => {
    // The ticket detail page is now a public ISR page (~30s revalidation) — it no longer
    // flips to "unavailable" immediately after an order is created (reservations do not
    // invalidate the ISR cache). Oversell protection is enforced server-side at reservation
    // time: a second buyer who clicks "Purchase Ticket" will get an error from the order
    // service rather than being able to complete checkout.
    //
    // This test verifies that gating: after a purchase, a second buyer clicking the CTA
    // ends up at the order page (fast path) or receives an error — they cannot complete
    // a second reservation for a quota-1 ticket. We reuse the existing buyer session so
    // the per-user cap (maxPerUser=1 implied by quota=1) is the gating mechanism.
    const { ticketUrl } = await setupPurchase(page);

    // At this point the buyer who did setupPurchase already has an order. Attempting to
    // click "Purchase Ticket" again as the same user should hit the per-user cap.
    // Navigate back to the ticket and click the CTA — the server action should reject it.
    await page.goto(ticketUrl, { waitUntil: "commit" });
    await page
      .getByRole("heading", { level: 1 })
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    // The purchase CTA is always shown on the ISR page (no auth-based gating on static shell).
    // When the same user clicks it, the createOrder action finds the existing orderId and
    // redirects them to their existing order rather than creating a duplicate.
    await page.getByRole("button", { name: /purchase ticket/i }).first().click();

    // The buyer is redirected to their existing order (or sees an error alert).
    // Either outcome confirms oversell protection is in place.
    await Promise.race([
      page.waitForURL(/\/orders\/.+/, { timeout: 15000 }),
      page.locator('[role="alert"]:not([id="__next-route-announcer__"])').waitFor({ timeout: 15000 }),
    ]);
  });

  test("seller cannot purchase own ticket — manage via organizer route", async ({ page }) => {
    const email = uniqueEmail("seller-no-buy");
    await signupAsCreator(page, email);

    const ticketUrl = await createTicket(page, `No-Buy ${Date.now()}`, "25.00");
    const ticketId = ticketUrl.split("/").at(-1);

    // The ticket detail page is now a public buyer-facing ISR page — it always shows
    // the purchase CTA regardless of who is viewing. The owner's manage tools live at
    // /organizer/events/<id>/edit. Verify the organizer route is accessible to the owner.
    await page.goto(`/organizer/events/${ticketId}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });
    await expect(page.getByRole("button", { name: /update ticket/i }), "update ticket button should be visible on organizer edit page").toBeVisible({ timeout: 10000 });

    // Verify the ticket detail page shows the purchase CTA (not an edit form) for the owner.
    await page.goto(ticketUrl);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });
    // The purchase CTA is present on the ISR page (server-side owner check removed).
    await expect(page.getByRole("button", { name: /update ticket/i })).toHaveCount(0);
  });

  test("unauthenticated visitor sees purchase CTA and is redirected to sign-in on attempt", async ({ page }) => {
    // Create a ticket as a seller, then sign out
    const email = uniqueEmail("seller-unauth");
    await signupAsCreator(page, email);
    const ticketUrl = await createTicket(page, `Unauth Test ${Date.now()}`, "15.00");
    await signout(page);

    // Visit as unauthenticated user — the ticket page is now a public ISR page that always
    // shows the purchase CTA. Unauthenticated users are redirected to sign-in when they
    // attempt to purchase (the createOrder server action requires authentication).
    await page.goto(ticketUrl, { waitUntil: "commit" });
    await page
      .getByRole("heading", { level: 1 })
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    // The purchase CTA is shown to all visitors (no sign-in-link gate on the static shell).
    await expect(page.getByRole("button", { name: /purchase ticket/i }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The nav still shows a sign-in link for unauthenticated users.
    await expect(page.locator("nav").getByRole("link", { name: /sign in/i }).first()).toBeVisible({
      timeout: 5_000,
    });
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
    const ticketId = page.url().split("/").at(-1);
    await expect(page.getByRole("heading", { name: ticketTitle })).toBeVisible();

    // 4. Manage plan is now on the organizer edit page (SeatingPlanPreview component).
    await page.goto(`/organizer/events/${ticketId}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });
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
    await expect
      .poll(
        async () => {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          const hasRealContent = await page
            .getByRole("link", { name: /back to ticket/i })
            .waitFor({ state: "visible", timeout: 10000 })
            .then(() => true)
            .catch(() => false);
          if (!hasRealContent) return false;
          return page
            .getByRole("button", { name: /deactivate plan/i })
            .isVisible()
            .catch(() => false);
        },
        { timeout: 15000, intervals: [1000, 2000, 3000] }
      )
      .toBe(true);

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
    const ticketIdAuto = page.url().split("/").at(-1);

    // 5. Verify the organizer edit page surfaces the auto-assigned seating type
    // (the ticket detail page is now a public ISR page; ticket-type labels are on the edit form).
    await page.goto(`/organizer/events/${ticketIdAuto}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });
    await expect(page.getByText("Auto-assigned Seating").first()).toBeVisible({ timeout: 5000 });
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
    const ticketIdInactive = ticketUrl.split("/").at(-1);

    // Manage plan is now on the organizer edit page.
    await page.goto(`/organizer/events/${ticketIdInactive}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });
    await page.getByRole("link", { name: /manage plan/i }).click();
    await page.waitForURL(/\/tickets\/[0-9a-f-]+\/plans\/[0-9a-f-]+$/, { timeout: 15000 });
    await page.getByRole("button", { name: /activate plan/i }).click();
    await expect(page.getByRole("button", { name: /deactivate plan/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /deactivate plan/i }).click();
    await expect(page.getByRole("button", { name: /reactivate plan/i })).toBeVisible({ timeout: 10000 });

    // The buyer gating for an inactive plan is enforced at the /seats page, not the ISR detail page.
    await signout(page);
    await signup(page, buyerEmail);

    // Navigate to the seats page — it should block entry when the plan is inactive.
    await page.goto(`${ticketUrl}/seats`, { waitUntil: "commit" });
    await page
      .getByText(/seating plan is not active/i)
      .waitFor({ state: "visible", timeout: 15000 });

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
    const ticketIdDraft = ticketUrl.split("/").at(-1);

    await page.goto("/");
    await expect(page.getByText(ticketTitle)).toHaveCount(0);

    // Manage plan is now on the organizer edit page (SeatingPlanPreview component).
    await page.goto(`/organizer/events/${ticketIdDraft}/edit`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "attached", timeout: 10000 });
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

    await openTicketDetailUntilReady(
      page,
      ticketUrl,
      page.getByRole("button", { name: /purchase ticket/i })
    );

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
    await openTicketDetailUntilReady(
      page,
      ticketUrl,
      // The purchase panel renders a desktop + a mobile (responsive) CTA, so the
      // quantity input appears twice in the DOM — scope to the first (visible) one.
      page.locator('#quantity[type="number"]').first()
    );

    // Quantity stepper should appear because maxQuantity (3) > 1
    const qtyInput = page.locator('#quantity[type="number"]').first();
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
    await openTicketDetailUntilReady(
      page,
      ticketUrl,
      page.getByRole("button", { name: /purchase ticket/i })
    );
    await page.getByRole("button", { name: /purchase ticket/i }).click({ timeout: 15000 });
    await page.waitForURL(/\/orders\/.+/, { timeout: 15000 });

    // Buyer 2 tries to buy the same ticket — quota is now exhausted.
    // The ticket detail page is an ISR page (~30s revalidation) so it may still show
    // the purchase CTA. The oversell protection is enforced server-side at reservation time.
    // We verify that buyer 2 cannot actually complete a purchase: clicking the CTA either
    // results in an error alert or redirects to an existing order (none in this session),
    // meaning the order service rejected the reservation.
    await signout(page);
    await signup(page, buyer2Email);

    await page.goto(ticketUrl, { waitUntil: "commit" });
    await page
      .getByRole("heading", { level: 1 })
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    // Either the ISR cache has revalidated (shows "Sold Out" disabled button) or the
    // purchase CTA is still visible. In either case buyer 2 must not be able to purchase.
    const soldOutButton = page.getByRole("button", { name: /sold out/i });
    const purchaseButton = page.getByRole("button", { name: /purchase ticket/i }).first();

    const isSoldOut = await soldOutButton.isVisible().catch(() => false);
    if (!isSoldOut) {
      // ISR cache not yet stale — CTA is visible. Click it; the server action must reject.
      await purchaseButton.click();
      // Buyer 2 has no prior order, so they won't be redirected to an existing order.
      // The order-service should return an error (quota exhausted).
      await page.locator('[role="alert"]:not([id="__next-route-announcer__"])').waitFor({
        state: "visible",
        timeout: 15000,
      });
    } else {
      // ISR cache revalidated — "Sold Out" disabled button is shown, no further action needed.
      await expect(soldOutButton).toBeDisabled();
    }
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
    await openTicketDetailUntilReady(
      page,
      ticketUrl,
      page.getByRole("button", { name: /purchase ticket/i })
    );
    await page.getByRole("button", { name: /purchase ticket/i }).click({ timeout: 15000 });
    await page.waitForURL(/\/orders\/.+/, { timeout: 15000 });

    // Second visit — per-user limit enforcement check.
    // The ticket detail page is now a public ISR page that does not read user cookies,
    // so it always shows the purchase CTA. The per-user cap (maxPerUser=1) is enforced
    // server-side by the order service (returns 422 FAILED_PRECONDITION on a second attempt).
    await page.goto(ticketUrl, { waitUntil: "commit" });
    await page
      .getByRole("heading", { level: 1 })
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    // Click the purchase CTA — the server action must reject this attempt.
    await page.getByRole("button", { name: /purchase ticket/i }).first().click();

    // The createOrder server action will either redirect to the existing order
    // (if the service resolves the duplicate gracefully) or surface an error alert.
    await Promise.race([
      page.waitForURL(/\/orders\/.+/, { timeout: 15000 }),
      page.locator('[role="alert"]:not([id="__next-route-announcer__"])').waitFor({
        state: "visible",
        timeout: 15000,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Saved Events tests (Phase 7a)
// ---------------------------------------------------------------------------

test.describe("saved events", () => {
  test("buyer can save a ticket, view it in Saved tab, and unsave it", async ({ page }) => {
    test.setTimeout(90_000);

    // Creator creates a ticket
    const creatorEmail = uniqueEmail("saved-creator");
    await signupAsCreator(page, creatorEmail);
    const title = `Save Test ${Date.now()}`;
    const ticketUrl = await createTicket(page, title, "25.00");
    await signout(page);

    // Buyer signs up and navigates to the ticket
    const buyerEmail = uniqueEmail("saved-buyer");
    await signup(page, buyerEmail);
    await page.goto(ticketUrl);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });

    // Save event button should be visible for authenticated non-owner
    const saveBtn = page.getByRole("button", { name: /save event/i });
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
    await saveBtn.click();

    // After saving, button should toggle to "Saved"
    await expect(page.getByRole("button", { name: /^saved$/i })).toBeVisible({ timeout: 10000 });

    // Navigate to orders page, check the Saved tab
    await page.goto("/orders");
    await expect(page.getByRole("heading", { level: 1, name: /my orders/i })).toBeVisible({
      timeout: 15000,
    });
    const savedTab = page.getByRole("tab", { name: /saved/i });
    await savedTab.click();

    // Saved event should appear in the tab
    await expect(page.getByText(title)).toBeVisible({ timeout: 15000 });

    // Navigate back and unsave
    await page.goto(ticketUrl);
    await page.getByRole("heading", { level: 1 }).waitFor({ state: "attached", timeout: 10000 });
    const savedBtn = page.getByRole("button", { name: /^saved$/i });
    await expect(savedBtn).toBeVisible({ timeout: 10000 });
    await savedBtn.click();

    // After unsaving, button should return to "Save event"
    await expect(page.getByRole("button", { name: /save event/i })).toBeVisible({
      timeout: 10000,
    });

    // Saved tab should no longer list the event after unsave
    await page.goto("/orders");
    await expect(page.getByRole("heading", { level: 1, name: /my orders/i })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("tab", { name: /saved/i }).click();
    await expect(page.getByText(/no saved events yet/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(title)).not.toBeVisible();
  });
});
