import { test, expect } from "@playwright/test";
import { KONG_URL, signupViaApi } from "./_helpers/oauth";
import { PASSWORD, uniqueEmail } from "./_helpers/flows";

// Requires the full stack + queue group, and the client started with the gate
// armed against a seeded, already-open, high-rate event. See the run recipe in
// docs/superpowers/plans/2026-06-16-virtual-waiting-room-connector.md (Task 4).
// Skipped unless E2E_QUEUE_ARMED=1 so it never runs in the normal E2E pass.

const ARMED = process.env.E2E_QUEUE_ARMED === "1";
const TICKET = process.env.E2E_TICKET_ID || "any";

test.describe("virtual waiting room", () => {
  test.skip(!ARMED, "set E2E_QUEUE_ARMED=1 with the gate armed + queue stack up");

  test("an un-admitted visitor is redirected to the waiting room", async ({ page }) => {
    // The seeded event is already open, so the page would claim and leave at
    // once; hold it on the waiting page to check the redirect and the render.
    await page.route("**/api/claim**", (r) => r.abort());
    await page.goto(`/tickets/${TICKET}`);
    await expect(page).toHaveURL(/\/wait\?e=/);
    await expect(page.locator("#countdown")).toBeVisible();
  });

  // Only the armed event's purchase pages are gated (QUEUE_EVENT_ID is that
  // event's ticket id); browsing and payment pages stay open to everyone.
  test("pages outside the armed event's purchase path load without the queue", async ({ page }) => {
    await page.route("**/api/claim**", (r) => r.abort());
    for (const path of ["/", "/tickets/not-the-armed-event", `/tickets/${TICKET}/admission`, "/orders"]) {
      await page.goto(path);
      expect(page.url(), path).not.toContain("/wait?e=");
    }
  });

  test("the armed event's seat picker is redirected to the waiting room", async ({ page }) => {
    await page.route("**/api/claim**", (r) => r.abort());
    await page.goto(`/tickets/${TICKET}/seats`);
    await expect(page).toHaveURL(/\/wait\?e=/);
  });

  // The pass is bound to an account when redeemed, so an admitted visitor who
  // is not logged in is sent to sign in. The admission token waits in a cookie,
  // not in the sign-in URL (history, logs, Referer), and signing in brings them
  // back to redeem it instead of back to the queue.
  test("an admitted visitor who is not logged in signs in and comes back with a pass", async ({ page, context }) => {
    const email = uniqueEmail("waiting-room");
    const signup = await fetch(`${KONG_URL}/api/users/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(signup.status).toBe(201);

    await page.goto(`/tickets/${TICKET}`);
    await page.waitForURL(/\/auth\/signin\?next=/, { timeout: 15000 });
    expect(page.url()).not.toContain("qpass");
    expect((await context.cookies()).some((c) => c.name === "qq_admit")).toBe(true);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((u) => u.pathname === `/tickets/${TICKET}` && !u.searchParams.has("qpass"), { timeout: 15000 });
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name === "qq_pass")).toBe(true);
    expect(cookies.some((c) => c.name === "qq_admit")).toBe(false);
  });

  test("a logged-in admitted visitor reaches the ticket page with a pass bound to them", async ({ page, context, baseURL }) => {
    const { accessToken } = await signupViaApi();
    await context.addCookies([{ name: "token", value: accessToken, url: baseURL! }]);
    // High-rate open event: the waiting page auto-claims within a couple polls
    // and redirects back with the admission token, which is redeemed for a pass.
    await page.goto(`/tickets/${TICKET}`);
    await page.waitForURL((u) => u.pathname.startsWith("/tickets/") && !u.searchParams.has("qpass"), { timeout: 15000 });
    const pass = (await context.cookies()).find((c) => c.name === "qq_pass");
    expect(pass).toBeDefined();
    const claims = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString());
    expect(claims(pass!.value, 0).Sub).toBe(claims(accessToken, 1).sub);
  });
});
