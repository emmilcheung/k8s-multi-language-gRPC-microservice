import { test, expect } from "@playwright/test";

const password = "password123";

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}@test.com`;
}

async function signup(page: import("@playwright/test").Page, email: string) {
  await page.goto("/auth/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("/");
}

test("buyer can purchase a listed ticket", async ({ page }) => {
  const sellerEmail = uniqueEmail("seller");
  const buyerEmail = uniqueEmail("buyer");

  await signup(page, sellerEmail);

  await page.goto("/tickets/new");
  await expect(page.getByRole("heading", { name: /list a ticket/i })).toBeVisible();
  await page.getByLabel("Title").fill("Playwright E2E Concert");
  await page.getByLabel("Price (USD)").fill("42.00");
  await page.getByRole("button", { name: /create ticket/i }).click();

  await page.waitForURL(/\/tickets\/[0-9a-f\-]+/);
  const ticketUrl = page.url();
  expect(ticketUrl).toContain("/tickets/");

  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();

  await signup(page, buyerEmail);
  await page.goto(ticketUrl);

  await expect(page.getByRole("heading", { name: /playwright e2e concert/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /purchase ticket/i })).toBeVisible();

  await page.getByRole("button", { name: /purchase ticket/i }).click();
  await page.waitForURL(/\/orders\/[0-9a-f\-]+/);
  await expect(page.getByRole("button", { name: /purchase ticket/i })).toHaveCount(0);
});
