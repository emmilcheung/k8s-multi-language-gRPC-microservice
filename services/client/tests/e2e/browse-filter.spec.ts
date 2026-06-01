import { test, expect } from "@playwright/test";
import { signup, uniqueEmail, createTicketViaApi } from "./_helpers/flows";

test.describe("browse filter", () => {
  test.setTimeout(60_000);

  // Generate unique tag per test run to avoid collisions with other tests
  const tag = uniqueEmail("browse-tag").split("@")[0];

  test.beforeAll(async ({ browser }) => {
    // Sign up and create test tickets
    const context = await browser.newContext();
    const page = await context.newPage();

    const email = uniqueEmail("browse-creator");
    await signup(page, email);

    // Create a unique set of test tickets for filtering
    await createTicketViaApi(page, {
      title: `Concert-${tag}-A`,
      price: "78.00",
      category: "CONCERT",
      startsAt: "2026-08-15T19:00:00Z",
      venueName: "Test Venue",
    });
    await createTicketViaApi(page, {
      title: `Concert-${tag}-B`,
      price: "22.00",
      category: "CONCERT",
      startsAt: "2026-09-10T18:00:00Z",
      venueName: "Test Venue",
    });
    await createTicketViaApi(page, {
      title: `Sports-${tag}`,
      price: "120.00",
      category: "SPORTS",
      startsAt: "2026-07-20T14:00:00Z",
      venueName: "Stadium",
    });
    await createTicketViaApi(page, {
      title: `Comedy-${tag}`,
      price: "15.00",
      category: "COMEDY",
      startsAt: "2026-10-05T20:00:00Z",
      venueName: "Comedy Club",
    });

    await context.close();
  });

  test("category filter shows only tickets in that category", async ({
    page,
  }) => {
    await signup(page, uniqueEmail("browse-category"));
    await page.goto("/?category=concert");

    // Wait for RSC streaming and grid heading
    await expect(page.getByRole("heading", { name: /events/i })).toBeVisible({
      timeout: 8000,
    });

    // Concert tickets should be visible
    await expect(page.getByText(`Concert-${tag}-A`)).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText(`Concert-${tag}-B`)).toBeVisible({
      timeout: 5000,
    });

    // Sports and Comedy should NOT be visible
    await expect(page.getByText(`Sports-${tag}`)).toHaveCount(0);
    await expect(page.getByText(`Comedy-${tag}`)).toHaveCount(0);
  });

  test("text search matches titles", async ({ page }) => {
    await signup(page, uniqueEmail("browse-search"));
    await page.goto(`/?q=Sports-${tag}`);

    // Wait for RSC streaming and grid heading
    await expect(page.getByRole("heading", { name: /events/i })).toBeVisible({
      timeout: 8000,
    });

    // Sports ticket should be visible
    await expect(page.getByText(`Sports-${tag}`)).toBeVisible({
      timeout: 5000,
    });

    // Concert and Comedy should NOT be visible
    await expect(page.getByText(`Concert-${tag}-A`)).toHaveCount(0);
    await expect(page.getByText(`Concert-${tag}-B`)).toHaveCount(0);
    await expect(page.getByText(`Comedy-${tag}`)).toHaveCount(0);
  });

  test("price band filters by price", async ({ page }) => {
    await signup(page, uniqueEmail("browse-price"));
    await page.goto("/?price=0-25");

    // Wait for RSC streaming and grid heading
    await expect(page.getByRole("heading", { name: /events/i })).toBeVisible({
      timeout: 8000,
    });

    // Comedy ($15) and Concert-B ($22) should be visible
    await expect(page.getByText(`Comedy-${tag}`)).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText(`Concert-${tag}-B`)).toBeVisible({
      timeout: 5000,
    });

    // Sports ($120) and Concert-A ($78) should NOT be visible
    await expect(page.getByText(`Sports-${tag}`)).toHaveCount(0);
    await expect(page.getByText(`Concert-${tag}-A`)).toHaveCount(0);
  });
});
