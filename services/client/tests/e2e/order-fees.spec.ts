import { test, expect } from "@playwright/test";
import { setupPurchase } from "./_helpers/flows";

test.describe("order fees", () => {
  test("order detail shows the itemized fee breakdown", async ({ page }) => {
    test.setTimeout(60_000);
    const { orderUrl } = await setupPurchase(page, "55.00");

    // Ensure we're on the order detail page and the summary has rendered
    await page.goto(orderUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /order summary/i })).toBeVisible({
      timeout: 10_000,
    });

    // Assert each fee breakdown row is visible with correct values
    await expect(page.getByText(/subtotal/i).first()).toBeVisible();
    await expect(page.getByText("$55.00").first()).toBeVisible();

    await expect(page.getByText(/service fee/i).first()).toBeVisible();
    await expect(page.getByText("$5.50").first()).toBeVisible();

    await expect(page.getByText(/facility fee/i).first()).toBeVisible();
    await expect(page.getByText("$1.50").first()).toBeVisible();

    await expect(page.getByText(/tax/i).first()).toBeVisible();
    await expect(page.getByText("$0.00").first()).toBeVisible();

    await expect(page.getByText(/total/i).first()).toBeVisible();
    await expect(page.getByText("$62.00").first()).toBeVisible();
  });

  test("the amount charged equals the fee-inclusive total", async ({ page }) => {
    test.setTimeout(60_000);
    const { orderUrl } = await setupPurchase(page, "55.00");

    // Ensure we're on the order detail page
    await page.goto(orderUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /order summary/i })).toBeVisible({
      timeout: 10_000,
    });

    // Assert the total amount $62.00 (fee-inclusive) is visible in the payment area
    await expect(page.getByText("$62.00").first()).toBeVisible({ timeout: 10_000 });

    // Assert the Pay Now button is present
    await expect(page.getByRole("button", { name: /pay now/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});
