// _helpers/flows.ts — Shared E2E flow helpers.
//
// Extracted so multiple spec files can reuse the same signup / ticket-creation /
// purchase / Stripe-mock logic without duplicating it. Mirrors the helpers in
// ticketing.spec.ts (the source of truth for the buyer journey).

import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = "Password123!";

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`;
}

export async function signup(page: Page, email: string) {
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

export async function signout(page: Page) {
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/\/auth\/signin/);
}

/**
 * Fill a React controlled input and properly trigger onChange (bypasses React's
 * value tracking so a Server Action receives the value).
 */
export async function fillInputAndTriggerChange(page: Page, selector: string, value: string) {
  const input = page.locator(selector);
  await input.evaluate((el: HTMLInputElement, val: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/** Creates a GA ticket as the signed-in user via the UI; returns the ticket URL. */
export async function createTicket(page: Page, title: string, price: string) {
  await page.goto("/tickets/new");

  const gaButton = page.getByRole("button", { name: /general admission/i });
  await gaButton.waitFor({ state: "visible", timeout: 5000 });
  await gaButton.click();

  await page.locator("#title").waitFor({ state: "visible", timeout: 5000 });
  await fillInputAndTriggerChange(page, "#title", title);
  await fillInputAndTriggerChange(page, "#price", price);
  await fillInputAndTriggerChange(page, "#startsAt", "2025-05-11T14:00");

  const form = page.locator("form", { has: page.locator("#title") });
  const submitButton = form.getByRole("button", { name: /create ticket/i });
  await submitButton.waitFor({ state: "visible", timeout: 5000 });
  await submitButton.click();

  try {
    await page.waitForURL((url) => !url.pathname.endsWith("/new"), { timeout: 15000 });
  } catch {
    const alertContent = await page.locator('[role="alert"]').first().textContent().catch(() => null);
    throw new Error(`Ticket creation failed. Alert: ${alertContent}`);
  }
  return page.url();
}

/**
 * Creates a GA ticket directly via the ticket-service REST API (POST /api/tickets),
 * reusing the browser's auth cookie. Use this when the UI form can't express a field
 * (e.g. `category`, which the create form does not surface). Returns the new ticket id.
 */
export async function createTicketViaApi(
  page: Page,
  input: { title: string; price: string; category?: string; startsAt?: string; venueName?: string }
): Promise<string> {
  const body: Record<string, unknown> = {
    title: input.title,
    price: input.price,
    quota: 100,
    maxPerUser: 4,
  };
  if (input.category) body.category = input.category;
  if (input.startsAt || input.venueName) {
    body.event = {
      title: input.title,
      startsAt: input.startsAt ?? "2099-08-09T20:00:00Z",
      venueName: input.venueName ?? "Test Venue",
    };
  }
  const res = await page.request.post("http://localhost:8000/api/tickets", {
    headers: { "Content-Type": "application/json" },
    data: body,
  });
  if (!res.ok()) {
    throw new Error(`createTicketViaApi failed: ${res.status()} ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

/**
 * Seller creates a GA ticket, buyer purchases it. Leaves the page on the order
 * detail (status created/awaiting_payment). Returns the order URL + ticket title.
 */
export async function setupPurchase(
  page: Page,
  price = "55.00"
): Promise<{ orderUrl: string; ticketTitle: string }> {
  const sellerEmail = uniqueEmail("seller-flow");
  const buyerEmail = uniqueEmail("buyer-flow");
  const ticketTitle = `Flow E2E ${Date.now()}`;

  await signup(page, sellerEmail);
  const ticketUrl = await createTicket(page, ticketTitle, price);

  await signout(page);
  await signup(page, buyerEmail);

  await page.goto(ticketUrl, { waitUntil: "domcontentloaded" });
  const purchaseBtn = page.getByRole("button", { name: /purchase ticket/i });
  await purchaseBtn.waitFor({ state: "visible", timeout: 15000 });
  await purchaseBtn.click();
  await page.waitForURL(/\/orders\/.+/);

  return { orderUrl: page.url(), ticketTitle };
}

/** Installs a window.Stripe mock so the payment form completes without real Stripe. */
export async function installStripeMock(
  page: Page,
  options: { paymentMethodId?: string; errorMessage?: string } = {}
) {
  await page.addInitScript((mockOptions) => {
    class MockCardElement {
      private _changeHandler:
        | ((event: { error?: { message?: string }; complete: boolean }) => void)
        | null = null;
      on(event: string, handler: (e: { error?: { message?: string }; complete: boolean }) => void) {
        if (event === "change") this._changeHandler = handler;
      }
      off() {}
      mount(container: HTMLElement | string) {
        const target =
          typeof container === "string" ? document.querySelector(container) : container;
        if (target instanceof HTMLElement) {
          target.setAttribute("data-stripe-mock", "mounted");
          target.textContent = "Mock card input";
        }
        if (this._changeHandler) this._changeHandler({ complete: true });
      }
      unmount() {}
    }
    Object.defineProperty(window, "Stripe", {
      configurable: true,
      writable: true,
      value: () => ({
        elements: () => ({ create: () => new MockCardElement() }),
        createPaymentMethod: async () => {
          if (mockOptions.errorMessage) return { error: { message: mockOptions.errorMessage } };
          return { paymentMethod: { id: mockOptions.paymentMethodId ?? "pm_mock_success" } };
        },
      }),
    });
  }, options);
}

/** Clicks Pay Now and waits for the submit-payment Server Action request to fire. */
export async function clickPayNowAndWaitForSubmitPayment(page: Page) {
  const submitPaymentRequest = page.waitForRequest(
    (request) => request.method() === "POST" && Boolean(request.headers()["next-action"]),
    { timeout: 60_000 }
  );
  await page.getByRole("button", { name: /pay now/i }).click();
  return submitPaymentRequest;
}

/** Completes the mocked Stripe payment from an order page and waits for "complete". */
export async function payAndWaitForComplete(page: Page) {
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
}
