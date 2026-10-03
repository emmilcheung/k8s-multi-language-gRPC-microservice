/**
 * connected-apps.spec.ts: an MCP host connects through the real consent page,
 * the grant shows up under Settings → Connected apps, and revoking it kills
 * the host's refresh token. Consent labels come from the registry.
 */
import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { signup, uniqueEmail } from "./_helpers/flows";
import { KONG_URL, MCP_CLIENT_ID, MCP_REDIRECT_URI, authorizeUrl } from "./_helpers/oauth";

interface RegistryScope {
  scope: string;
  label: string;
  sensitive: boolean;
}

test("L-3: connect an app, see it in Connected apps, revoke it, refresh fails with invalid_grant", async ({
  page,
}) => {
  const registry = (await (await fetch(`${KONG_URL}/oauth/scopes`)).json()) as RegistryScope[];
  expect(registry.length).toBeGreaterThan(0);

  await signup(page, uniqueEmail("connected-apps"));

  // The MCP host's authorize request, opened in the user's browser.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const scope = registry.map((s) => s.scope).join(" ");

  // The host's loopback callback is not listening: capture the redirect instead.
  let code = "";
  await page.route(`${MCP_REDIRECT_URI}**`, async (route) => {
    code = new URL(route.request().url()).searchParams.get("code") ?? "";
    await route.fulfill({ status: 200, contentType: "text/html", body: "connected" });
  });

  await page.goto(authorizeUrl(scope, challenge));
  await expect(page.getByRole("heading", { name: /allow access/i })).toBeVisible();

  // L-1 in a real browser: a label for every registry scope, sensitive ones flagged.
  for (const s of registry) {
    await expect(page.getByText(s.label, { exact: true }), `label for ${s.scope}`).toBeVisible();
  }
  const sensitiveCount = registry.filter((s) => s.sensitive).length;
  await expect(page.getByText("Sensitive", { exact: true })).toHaveCount(sensitiveCount);

  await page.getByRole("button", { name: /allow access/i }).click();
  await expect.poll(() => code, { timeout: 15000 }).not.toBe("");

  const tokenRes = await fetch(`${KONG_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: MCP_CLIENT_ID,
      redirect_uri: MCP_REDIRECT_URI,
    }),
  });
  expect(tokenRes.status).toBe(200);
  const { refresh_token: refreshToken } = (await tokenRes.json()) as { refresh_token: string };

  const refresh = () =>
    fetch(`${KONG_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: MCP_CLIENT_ID,
      }),
    });

  // Connected apps lists the app.
  await page.goto("/settings");
  const row = page.getByTestId("connected-app");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Ticketing MCP Server");
  await expect(row).toContainText("orders:create");

  // Revoke removes the row...
  await row.getByRole("button", { name: /revoke/i }).click();
  await expect(page.getByTestId("connected-app")).toHaveCount(0);
  await expect(page.getByText(/no connected apps/i)).toBeVisible();

  // ...and the host's next refresh is refused.
  const after = await refresh();
  expect(after.status).toBe(400);
  expect(await after.json()).toMatchObject({ error: "invalid_grant" });
});
