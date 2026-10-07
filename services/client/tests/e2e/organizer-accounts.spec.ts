/**
 * organizer-accounts.spec.ts — Organizer accounts through the real stack.
 *
 * A new user creates an organizer account and an event, invites a second user
 * to the team, who accepts the invitation and edits the event. Needs the
 * services to enforce organizer permissions (AUTHZ_ENFORCED=on for ticket,
 * venue and attendance service), otherwise the invitee could edit anyway.
 */

import { test, expect } from "@playwright/test";
import {
  PASSWORD,
  createOrganizerAccount,
  createTicket,
  fillInputAndTriggerChange,
  signout,
  signup,
  uniqueEmail,
} from "./_helpers/flows";

test.setTimeout(120_000);

test("a new user creates an account, invites a second user, who accepts and edits an event", async ({ page }) => {
  test.skip(
    process.env.E2E_AUTHZ_ENFORCED !== "on",
    "needs the platform running with permission enforcement on (set E2E_AUTHZ_ENFORCED=on)"
  );
  const ownerEmail = uniqueEmail("acct-owner");
  const inviteeEmail = uniqueEmail("acct-invitee");

  // The invitee signs up first so the invitation can be addressed to a known user.
  await signup(page, inviteeEmail);
  await expect(page.getByRole("link", { name: /become an organizer/i }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: /^sell$/i })).toHaveCount(0);
  await signout(page);

  // Owner creates the account and an event.
  await signup(page, ownerEmail);
  await createOrganizerAccount(page, `Acme ${Date.now()}`);
  const ticketUrl = await createTicket(page, `Team Event ${Date.now()}`, "15.00");
  const ticketId = ticketUrl.split("/").at(-1);

  // Owner invites the second user as an event manager and copies the link.
  await page.goto("/organizer/team");
  await page.locator("#invite-email").fill(inviteeEmail);
  await page.locator("#invite-role").selectOption("EVENT_MANAGER");
  await page.getByRole("button", { name: /invite to team/i }).click();
  const acceptLink = await page.locator("#accept-link").inputValue();
  expect(acceptLink).toContain("/invitations/accept");
  await signout(page);

  // Invitee signs in, accepts, and edits the owner's event.
  await page.goto("/auth/signin");
  await page.getByLabel("Email").fill(inviteeEmail);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("/", { timeout: 15_000 });

  const acceptUrl = new URL(acceptLink, "http://localhost:4000");
  await page.goto(acceptUrl.pathname + acceptUrl.search);
  await page.getByRole("button", { name: /accept invitation/i }).click();
  await page.waitForURL(/\/organizer$/, { timeout: 15_000 });

  await page.goto(`/organizer/events/${ticketId}/edit`);
  await expect(page.getByRole("button", { name: /update ticket/i })).toBeVisible({ timeout: 10_000 });
  const updated = `Edited by invitee ${Date.now()}`;
  await fillInputAndTriggerChange(page, "#title", updated);
  await page.getByRole("button", { name: /update ticket/i }).click();
  await expect(page.getByRole("heading", { level: 1 }).nth(1)).toContainText(updated, { timeout: 10_000 });
});
