/**
 * oauth-agent-boundaries.spec.ts: an OAuth grant is worth exactly its scope.
 *
 * An agent holding `tickets:read orders:read` must not reach routes outside
 * that scope, whether it sends the token as a Bearer header or as the `token`
 * cookie. Browser sessions and the anonymous GraphQL token must be unaffected.
 * Spec: F2, F11, D9, C-10.
 */
import { test, expect } from "@playwright/test";
import { KONG_URL, authorizeUrl, obtainOAuthAccessToken, signupViaApi } from "./_helpers/oauth";

let session: { accessToken: string; refreshToken: string };
let oauth: { accessToken: string; refreshToken: string };

test.beforeAll(async () => {
  session = await signupViaApi();
  oauth = await obtainOAuthAccessToken(session.accessToken);
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const cookie = (t: string) => ({ Cookie: `token=${t}` });
const gql = (headers: Record<string, string>) =>
  fetch(`${KONG_URL}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query: "{ __typename }" }),
  });

test.describe("OAuth tokens are refused outside their scope", () => {
  for (const [how, headers] of [
    ["Bearer", () => bearer(oauth.accessToken)],
    ["cookie", () => cookie(oauth.accessToken)],
  ] as const) {
    test(`unscoped route refuses an OAuth token sent as ${how} (F11)`, async () => {
      const res = await fetch(`${KONG_URL}/api/users/sessions`, { headers: headers() });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
    });

    test(`scoped route refuses an OAuth token lacking the scope, sent as ${how} (F11 cookie bypass)`, async () => {
      const res = await fetch(`${KONG_URL}/api/payments/methods`, { headers: headers() });
      expect(res.status).toBe(403);
    });
  }

  test("consent approval refuses an OAuth token (breaks the scope-escalation chain)", async () => {
    const res = await fetch(`${KONG_URL}/oauth/consent/any-request-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(oauth.accessToken) },
      body: JSON.stringify({ approve: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
  });

  test("GraphQL refuses an OAuth token (F2)", async () => {
    const res = await gql(bearer(oauth.accessToken));
    expect(res.status).toBe(403);
  });
});

test.describe("everything that worked before still works", () => {
  test("an OAuth token still reaches a route inside its scope", async () => {
    const res = await fetch(`${KONG_URL}/api/orders`, { headers: bearer(oauth.accessToken) });
    expect(res.status).toBe(200);
  });

  test("a browser session still reaches an unscoped route", async () => {
    const res = await fetch(`${KONG_URL}/api/users/sessions`, { headers: cookie(session.accessToken) });
    expect(res.status).toBe(200);
  });

  test("a browser session still reaches GraphQL", async () => {
    expect((await gql(cookie(session.accessToken))).status).toBe(200);
  });

  test("an anonymous visitor still reaches GraphQL", async () => {
    expect((await gql({})).status).toBe(200);
  });
});

test.describe("sessions and grants never convert into each other", () => {
  test("an OAuth access token is not a session at /oauth/authorize (F11b)", async () => {
    const res = await fetch(authorizeUrl("orders:create payments:create", "x".repeat(43)), {
      redirect: "manual",
      headers: { Cookie: `token=${oauth.accessToken}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/signin?next=");
  });

  test("an OAuth refresh token cannot mint a browser session, and survives the attempt (F1)", async () => {
    const grant = await obtainOAuthAccessToken(session.accessToken);
    const browser = await fetch(`${KONG_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { Cookie: `refreshToken=${grant.refreshToken}` },
    });
    expect(browser.status).toBe(401);

    const agent = await fetch(`${KONG_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken, client_id: "ticketing-mcp" }),
    });
    expect(agent.status).toBe(200);
  });

  test("a browser refresh token is refused at /oauth/token in RFC shape, and the browser stays signed in (F1b, F9)", async () => {
    const user = await signupViaApi();
    const agent = await fetch(`${KONG_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: user.refreshToken, client_id: "ticketing-mcp" }),
    });
    expect(agent.status).toBe(400);
    expect(agent.headers.get("cache-control")).toBe("no-store");
    expect(await agent.json()).toMatchObject({ error: "invalid_grant" });

    const browser = await fetch(`${KONG_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { Cookie: `refreshToken=${user.refreshToken}` },
    });
    expect(browser.status).toBe(200);
  });
});
