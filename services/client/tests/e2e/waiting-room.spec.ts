import { test, expect } from "@playwright/test";

// Requires the full stack + queue group, and the client started with the gate
// armed against a seeded, already-open, high-rate event. See the run recipe in
// docs/superpowers/plans/2026-06-16-virtual-waiting-room-connector.md (Task 4).
// Skipped unless E2E_QUEUE_ARMED=1 so it never runs in the normal E2E pass.

const ARMED = process.env.E2E_QUEUE_ARMED === "1";
const TICKET = process.env.E2E_TICKET_ID || "any";

test.describe("virtual waiting room", () => {
  test.skip(!ARMED, "set E2E_QUEUE_ARMED=1 with the gate armed + queue stack up");

  test("an un-admitted visitor is redirected to the waiting room", async ({ page }) => {
    await page.goto(`/tickets/${TICKET}`);
    await expect(page).toHaveURL(/\/wait\?e=/);
    await expect(page.locator("#countdown")).toBeVisible();
  });

  test("an admitted visitor reaches the ticket page carrying a qq_pass cookie", async ({ page, context }) => {
    // High-rate open event: the waiting page auto-claims within a couple polls
    // and redirects back to /tickets/... with the admission token.
    await page.goto(`/tickets/${TICKET}`);
    await page.waitForURL(/\/tickets\//, { timeout: 15000 });
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name === "qq_pass")).toBe(true);
  });
});
