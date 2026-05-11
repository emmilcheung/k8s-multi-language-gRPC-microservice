/**
 * Attendance E2E — real Playwright browser test.
 *
 * Flow:
 *   Organizer signs up → creates ticket → signs out
 *   Buyer signs up → navigates to ticket → purchases → pays (mocked Stripe)
 *     → navigates to /tickets/[id]/admission → QR pass card renders in browser
 *   Buyer signs out; Organizer signs back in → /scan → fills scanner form with
 *     token extracted from the rendered DOM → check-in → asserts "valid"
 *     → repeats check-in → asserts "already_used"
 *
 * No API calls are mocked.  All requests flow: browser → Next.js dev → Kong proxy
 * → attendance-service → Postgres.
 */

import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PASSWORD = "Password123!";

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`;
}

// ---------------------------------------------------------------------------
// Shared helpers (follow ticketing.spec.ts conventions exactly)
// ---------------------------------------------------------------------------

async function signup(page: Page, email: string) {
  await page.goto("/auth/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign up/i }).click();
  try {
    await page.waitForURL("/", { timeout: 15_000 });
  } catch {
    const alert = await page
      .locator('[role="alert"]:not([id="__next-route-announcer__"])')
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(`Signup failed for ${email}. Alert: ${alert}`);
  }
}

async function signin(page: Page, email: string) {
  await page.goto("/auth/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  try {
    await page.waitForURL("/", { timeout: 15_000 });
  } catch {
    const alert = await page
      .locator('[role="alert"]:not([id="__next-route-announcer__"])')
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(`Signin failed for ${email}. Alert: ${alert}`);
  }
}

async function signout(page: Page) {
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/\/auth\/signin/);
}

/**
 * React-controlled inputs ignore plain DOM .value writes; this helper fires
 * the synthetic input event that React's onChange requires.
 */
async function fillInput(page: Page, selector: string, value: string) {
  await page.locator(selector).evaluate((el: HTMLInputElement, val: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeSetter) nativeSetter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/**
 * Replaces the real Stripe.js with an in-browser mock that auto-completes
 * card entry and returns a deterministic payment-method ID.
 * Must be called once before any page navigation (addInitScript persists).
 */
async function installStripeMock(page: Page) {
  await page.addInitScript(() => {
    class MockCardElement {
      private _cb: ((e: { complete: boolean }) => void) | null = null;
      on(ev: string, cb: (e: { complete: boolean }) => void) {
        if (ev === "change") this._cb = cb;
      }
      off() {}
      mount(container: string | HTMLElement) {
        const el =
          typeof container === "string"
            ? document.querySelector<HTMLElement>(container)
            : container;
        if (el) {
          el.setAttribute("data-stripe-mock", "mounted");
          el.textContent = "Mock card input";
        }
        this._cb?.({ complete: true });
      }
      unmount() {}
    }
    Object.defineProperty(window, "Stripe", {
      configurable: true,
      writable: true,
      value: () => ({
        elements: () => ({ create: () => new MockCardElement() }),
        createPaymentMethod: async () => ({
          paymentMethod: { id: "pm_mock_attendance_e2e" },
        }),
      }),
    });
  });
}

/**
 * Polls the /api/orders/:id endpoint from inside the browser context so the
 * session cookie is included automatically.
 */
async function waitForOrderComplete(
  page: Page,
  orderId: string,
  timeoutMs = 40_000
) {
  await page.waitForFunction(
    async (oid: string) => {
      try {
        const resp = await fetch(`/api/orders/${oid}`);
        if (!resp.ok) return false;
        const body = (await resp.json()) as { status?: string };
        return (body.status ?? "").toLowerCase() === "complete";
      } catch {
        return false;
      }
    },
    orderId,
    { timeout: timeoutMs, polling: 1500 }
  );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.setTimeout(120_000);

test(
  "attendance golden path: buyer views QR pass in browser, " +
    "scanner checks in and second scan is blocked",
  async ({ page }) => {
    // Stripe mock must be installed before any navigation.
    await installStripeMock(page);

    const organizerEmail = uniqueEmail("att-org");
    const buyerEmail = uniqueEmail("att-buyer");

    // ────────────────────────────────────────────────────────────────────────
    // Phase 1 — Organizer: create a GA ticket (quota=1, maxPerUser=1)
    // ────────────────────────────────────────────────────────────────────────
    await signup(page, organizerEmail);

    await page.goto("/tickets/new");
    await page
      .getByRole("button", { name: /general admission/i })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.getByRole("button", { name: /general admission/i }).click();

    await page.locator("#title").waitFor({ state: "visible", timeout: 5_000 });
    await fillInput(page, "#title", `Attendance E2E ${Date.now()}`);
    await fillInput(page, "#price", "10.00");
    await fillInput(page, "#startsAt", "2026-12-01T18:00");
    await fillInput(page, "#quota", "1");
    await fillInput(page, "#maxPerUser", "1");

    await page
      .locator("form", { has: page.locator("#title") })
      .getByRole("button", { name: /create ticket/i })
      .click();
    await page.waitForURL((url) => !url.pathname.endsWith("/new"), {
      timeout: 15_000,
    });

    // Extract UUID from /tickets/<uuid>
    const ticketId = page.url().split("/tickets/")[1]!.split("/")[0]!;
    expect(ticketId).toMatch(/^[0-9a-f-]{36}$/);

    await signout(page);

    // ────────────────────────────────────────────────────────────────────────
    // Phase 2 — Buyer: purchase ticket and pay via mocked Stripe
    // ────────────────────────────────────────────────────────────────────────
    await signup(page, buyerEmail);

    await page.goto(`/tickets/${ticketId}`, { waitUntil: "commit" });
    await page
      .getByRole("button", { name: /purchase ticket/i })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: /purchase ticket/i }).click();
    await page.waitForURL(/\/orders\/.+/, { timeout: 15_000 });

    // Capture orderId from the redirect URL /orders/<uuid>
    const orderId = page.url().split("/orders/")[1]!.split("?")[0]!;
    expect(orderId).toMatch(/^[0-9a-f-]{36}$/);

    const submitPaymentDone = page.waitForResponse(
      (r) =>
        r.url().includes("/api/submit-payment") &&
        r.request().method() === "POST",
      { timeout: 60_000 }
    );
    await page.getByRole("button", { name: /pay now/i }).click();
    await submitPaymentDone;

    // Wait for Kafka-driven order status to reach "complete" (polls via fetch
    // inside the browser context so the session cookie is included).
    await waitForOrderComplete(page, orderId);

    // ────────────────────────────────────────────────────────────────────────
    // Phase 3 — Buyer: admission page renders QR pass card
    //
    // attendance-service issues the pass asynchronously after consuming the
    // orders.order.completed Kafka event, so we retry the navigation until
    // the heading appears or the overall timeout expires.
    // ────────────────────────────────────────────────────────────────────────
    await expect(async () => {
      await page.goto(
        `/tickets/${ticketId}/admission?orderId=${orderId}`
      );
      await expect(
        page.getByRole("heading", { name: /your admission pass/i })
      ).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000, intervals: [2000, 3000, 5000] });

    // Assert QR pass card component is fully rendered in the browser DOM
    await expect(page.getByText("ISSUED")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByAltText("Admission QR code")).toBeVisible({
      timeout: 10_000,
    });

    // Extract the token bound to the rendered QR image. The value is not shown
    // as visible text in the UI, but remains available for deterministic scanner
    // E2E input.
    const qrToken = await page.getByAltText("Admission QR code").getAttribute("data-qr-token", {
      timeout: 5_000,
    });
    expect(qrToken).toBeTruthy();
    expect(qrToken!.length).toBeGreaterThan(20);

    await signout(page);

    // ────────────────────────────────────────────────────────────────────────
    // Phase 4 — Organizer: scanner console check-in flow
    // ────────────────────────────────────────────────────────────────────────
    await signin(page, organizerEmail);

    await page.goto(`/scan?eventId=${ticketId}`);
    await expect(
      page.getByRole("heading", { name: /scanner console/i })
    ).toBeVisible({ timeout: 10_000 });

    // Open fallback manual entry and populate token extracted from buyer admission page
    await page.getByRole("button", { name: /enter token manually/i }).click();
    await page.locator("#scanner-token").fill(qrToken!);

    // First scan — must be accepted
    await page.getByRole("button", { name: /check in attendee/i }).click();
    await expect(page.getByText(/checked in/i)).toBeVisible({
      timeout: 15_000,
    });

    // Second scan — one-time-use enforcement must reject it
    await page.getByRole("button", { name: /check in attendee/i }).click();
    await expect(page.getByText(/already checked in/i)).toBeVisible({
      timeout: 15_000,
    });
  }
);

test(
  "attendance fallback: organizer checks in purchased attendee by buyer email",
  async ({ page }) => {
    await installStripeMock(page);

    const organizerEmail = uniqueEmail("att-org");
    const buyerEmail = uniqueEmail("att-buyer");

    await signup(page, organizerEmail);

    await page.goto("/tickets/new");
    await page
      .getByRole("button", { name: /general admission/i })
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.getByRole("button", { name: /general admission/i }).click();

    await page.locator("#title").waitFor({ state: "visible", timeout: 5_000 });
    await fillInput(page, "#title", `Attendance E2E Email ${Date.now()}`);
    await fillInput(page, "#price", "10.00");
    await fillInput(page, "#startsAt", "2026-12-01T18:00");
    await fillInput(page, "#quota", "1");
    await fillInput(page, "#maxPerUser", "1");

    await page
      .locator("form", { has: page.locator("#title") })
      .getByRole("button", { name: /create ticket/i })
      .click();
    await page.waitForURL((url) => !url.pathname.endsWith("/new"), {
      timeout: 15_000,
    });
    const ticketId = page.url().split("/tickets/")[1]!.split("/")[0]!;

    // Manual email fallback is policy-gated; enable it before any sale locks settings.
    await page.goto(`/tickets/${ticketId}/attendance`);
    const manualOverrideToggle = page.getByLabel(/allow manual override/i);
    await expect(manualOverrideToggle).toBeVisible({ timeout: 10_000 });
    await manualOverrideToggle.check();
    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByText(/settings saved\./i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(manualOverrideToggle).toBeChecked();

    await signout(page);
    await signup(page, buyerEmail);

    await page.goto(`/tickets/${ticketId}`, { waitUntil: "commit" });
    await page
      .getByRole("button", { name: /purchase ticket/i })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: /purchase ticket/i }).click();
    await page.waitForURL(/\/orders\/.+/, { timeout: 15_000 });

    const orderId = page.url().split("/orders/")[1]!.split("?")[0]!;
    const submitPaymentDone = page.waitForResponse(
      (r) =>
        r.url().includes("/api/submit-payment") &&
        r.request().method() === "POST",
      { timeout: 60_000 }
    );
    await page.getByRole("button", { name: /pay now/i }).click();
    await submitPaymentDone;
    await waitForOrderComplete(page, orderId);

    await signout(page);
    await signin(page, organizerEmail);
    await page.goto(`/scan?eventId=${ticketId}`);
    await expect(
      page.getByRole("heading", { name: /scanner console/i })
    ).toBeVisible({ timeout: 10_000 });

    await page.getByLabel(/buyer email/i).fill(buyerEmail);
    await expect(async () => {
      await page.getByRole("button", { name: /check in by email/i }).click();
      await expect(page.getByText(/^checked in\.$/i)).toBeVisible({
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000, intervals: [2000, 3000, 5000] });

    await page.getByRole("button", { name: /check in by email/i }).click();
    await expect(page.getByText(/already checked in/i)).toBeVisible({
      timeout: 15_000,
    });
  }
);
