/**
 * mcp-full-flow.spec.ts (M-1): plays an MCP host's part end to end, without
 * Claude Code, against the real stack (Kong → auth-service / mcp-service →
 * Kong → order and payment services).
 *
 * WHY: every layer of the MCP surface has its own unit tests, but the promise
 * the platform makes is the chain: a host that knows only `<origin>/mcp` can
 * discover the authorization server, register itself, get a user's consent in
 * a real browser, and then place and pay for an order through audience-bound,
 * exchanged tokens. A break in any seam (metadata origins, audience, exchange
 * client secret, Kong routes, idempotency) shows up only here.
 *
 * Stack requirements (this spec FAILS, it does not skip, without them): compose
 * profile `mcp` (mcp-service) plus MCP_TOKEN_EXCHANGE_CLIENT_SECRET and its
 * _HASH in the root .env; Kong rendered for local (the /mcp routes and the
 * audience rule). The CI `e2e` job provides these.
 *
 * Payment: the spec cannot observe payment-service's STRIPE_SECRET_KEY, which
 * is a backend setting. It relies on `test_mock` (a deterministic mock where
 * charge() completes immediately and no network is used) and asserts the exact
 * mock outcome, so a non-mock backend fails loudly here instead of passing.
 * The saved card is registered through Settings with the same window.Stripe
 * mock ticketing.spec.ts uses; only when that registration backend answers
 * 5xx/404 (the same condition as ticketing.spec.ts) is the payment step
 * skipped, by name with the reason, which shows in the run summary.
 */
import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  createTicketViaApi,
  installStripeMock,
  signout,
  signup,
  uniqueEmail,
  PASSWORD,
} from "./_helpers/flows";
import { KONG_URL, obtainOAuthAccessToken, signupViaApi } from "./_helpers/oauth";

const MCP_URL = `${KONG_URL}/mcp`;
// Protocol versions mcp-service is tested against (services/mcp-service/src/protocol-eras.spec.ts:33,39).
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2026-07-28"];
const HOST_REDIRECT = "http://127.0.0.1:19877/callback";
const HOST_SCOPES = [
  "tickets:read",
  "orders:read",
  "orders:create",
  "payments:read",
  "payments:create",
];
const TOOL_NAMES = [
  "search_events",
  "get_event",
  "view_seat_availability",
  "list_my_orders",
  "get_order",
  "create_order",
  "create_seated_order",
  "cancel_order",
  "get_payment",
  "list_payment_methods",
  "pay_for_order",
  "pay_for_order_with_default",
];

interface RpcReply {
  status: number;
  headers: Headers;
  body: { result?: any; error?: any } | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** One JSON-RPC request over Streamable HTTP; accepts a JSON or a single-event SSE reply. */
async function rpc(
  token: string | undefined,
  method: string,
  params?: unknown,
  protocolVersion?: string,
): Promise<RpcReply> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body: RpcReply["body"];
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .pop();
    body = data ? JSON.parse(data) : undefined;
  } else {
    body = text ? JSON.parse(text) : undefined;
  }
  return { status: res.status, headers: res.headers, body };
}

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  rpc(token, "tools/call", { name, arguments: args }, state.protocolVersion);

function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

/** Shared by the serial steps below; a step failing skips the rest. */
const state = {
  protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
  authServer: "",
  registrationEndpoint: "",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  clientId: "",
  ticketId: "",
  ticketTitle: "",
  buyerEmail: "",
  paymentMethodSaved: false,
  paymentSkipReason: "",
  accessToken: "",
  orderId: "",
};

test.beforeAll(async () => {
  // Fail with the root cause, not eleven confusing failures, when the stack lacks mcp-service.
  let status: number | string;
  try {
    status = (await fetch(MCP_URL, { method: "POST" })).status;
  } catch (err) {
    status = err instanceof Error ? err.message : "unreachable";
  }
  if (status === 404 || status === 502 || status === 503 || status === 504 || typeof status === "string") {
    throw new Error(
      `mcp-service is not running (compose profile \`mcp\`): POST ${MCP_URL} answered ${status}. ` +
        "Start the stack with `docker compose --profile mcp up -d` and MCP_TOKEN_EXCHANGE_CLIENT_SECRET[_HASH] set.",
    );
  }
});

test.describe("MCP host without a token", () => {
  test("M-1 edge: /mcp without a token is 401 and points at the protected-resource metadata", async () => {
    const res = await rpc(undefined, "tools/list");
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      `resource_metadata="${KONG_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

test.describe.serial("MCP host: discover, register, authorize, call tools", () => {
  test("M-1: discovery walks protected-resource metadata to authorization-server metadata", async () => {
    const prm = await fetch(`${KONG_URL}/.well-known/oauth-protected-resource/mcp`);
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as { resource: string; authorization_servers: string[] };
    // The host must be able to match this exactly against the URL it was given.
    expect(prmBody.resource).toBe(MCP_URL);
    expect(prmBody.authorization_servers).toHaveLength(1);
    state.authServer = prmBody.authorization_servers[0].replace(/\/$/, "");

    const as = await fetch(`${state.authServer}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // RFC 8414 §3.3: the issuer echo is what SDK clients validate.
    expect(meta.issuer).toBe(state.authServer);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.grant_types_supported).toContain("authorization_code");
    expect(meta.registration_endpoint).toBeTruthy();
    state.registrationEndpoint = meta.registration_endpoint;
    state.authorizationEndpoint = meta.authorization_endpoint;
    state.tokenEndpoint = meta.token_endpoint;
  });

  test("M-1: dynamic client registration returns a client id for our loopback redirect", async () => {
    const res = await fetch(state.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "E2E MCP Host",
        redirect_uris: [HOST_REDIRECT],
        scope: HOST_SCOPES.join(" "),
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; client_name: string };
    expect(body.client_id).toBeTruthy();
    expect(body.client_name).toBe("E2E MCP Host");
    state.clientId = body.client_id;
  });

  test("M-1: seed a seller's event and the buyer's saved card", async ({ page }) => {
    test.setTimeout(120_000);

    await signup(page, uniqueEmail("mcp-seller"));
    state.ticketTitle = `MCP flow ${Date.now()}`;
    state.ticketId = await createTicketViaApi(page, { title: state.ticketTitle, price: "25.00" });
    await signout(page);

    state.buyerEmail = uniqueEmail("mcp-buyer");
    await installStripeMock(page, { paymentMethodId: `pm_mock_mcp_${Date.now()}_4242` });
    await signup(page, state.buyerEmail);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /^settings$/i })).toBeVisible({ timeout: 15000 });
    await page.getByLabel(/I consent to saving this payment method for future charges/i).check();
    const registered = page.waitForResponse(
      (r) =>
        r.url().includes("/settings") &&
        r.request().method() === "POST" &&
        Boolean(r.request().headers()["next-action"]),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /save payment method/i }).click();
    const status = (await registered).status();
    if (status >= 500 || status === 404) {
      state.paymentSkipReason = `Payment-method registration backend unavailable (${status})`;
      return;
    }
    await expect(page.getByText(/payment method saved successfully/i)).toBeVisible({ timeout: 15000 });
    state.paymentMethodSaved = true;
    await signout(page);
  });

  test("M-1: authorization code + PKCE with resource=<origin>/mcp, login and consent in a real browser", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    // The host's loopback listener is not running: capture the redirect instead.
    let redirect: URL | undefined;
    await page.route(`${HOST_REDIRECT}**`, async (route) => {
      redirect = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: "text/html", body: "connected" });
    });

    // A fresh browser context is logged out: the authorization endpoint must send the user through sign-in.
    const authorize = new URL(state.authorizationEndpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: state.clientId,
      redirect_uri: HOST_REDIRECT,
      scope: HOST_SCOPES.join(" "),
      state: "m1-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    }).toString();
    await page.goto(authorize.toString());
    await page.waitForURL(/\/auth\/signin/);

    await page.getByLabel("Email").fill(state.buyerEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByRole("heading", { name: /allow access/i })).toBeVisible({ timeout: 30_000 });
    // The consent page names the dynamically registered app and flags the powerful scopes.
    await expect(page.getByText("E2E MCP Host").first()).toBeVisible();
    await expect(page.getByText("Sensitive", { exact: true }).first()).toBeVisible();

    // Root cause of the lost click: app/oauth/consent/ConsentActions.tsx is a client component whose
    // buttons are enabled in the server HTML but have no handler until React hydrates, so an early
    // click does nothing. Retry the click until the redirect arrives; correct both before and after
    // the product fix that disables the buttons until mounted.
    const allow = page.getByRole("button", { name: /allow access/i });
    await expect(async () => {
      if (!redirect) await allow.click({ timeout: 2000 });
      await expect.poll(() => redirect?.searchParams.get("code") ?? "", { timeout: 3000 }).not.toBe("");
    }).toPass({ timeout: 30_000 });
    expect(redirect!.searchParams.get("state")).toBe("m1-state");
    // RFC 9207: the response names its issuer so a host can detect mix-up.
    expect(redirect!.searchParams.get("iss")).toBe(state.authServer);

    const token = await fetch(state.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirect!.searchParams.get("code")!,
        code_verifier: verifier,
        client_id: state.clientId,
        redirect_uri: HOST_REDIRECT,
        resource: MCP_URL,
      }),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; token_type: string };
    expect(body.token_type.toLowerCase()).toBe("bearer");
    state.accessToken = body.access_token;

    // Claim names and values only; the token itself is never printed.
    const c = claims(state.accessToken);
    expect(c.aud).toBe(MCP_URL);
    expect(c.iss).toBe(state.authServer);
    expect(c.client_id).toBe(state.clientId);
    expect(String(c.scope).split(" ").sort()).toEqual([...HOST_SCOPES].sort());
  });

  test("M-1: initialize negotiates a protocol version and tools/list returns the twelve tools", async () => {
    const init = await rpc(
      state.accessToken,
      "initialize",
      {
        protocolVersion: state.protocolVersion,
        capabilities: {},
        clientInfo: { name: "e2e-host", version: "0.0.0" },
      },
    );
    expect(init.status).toBe(200);
    expect(init.body?.result?.serverInfo?.name).toBeTruthy();
    state.protocolVersion = init.body?.result?.protocolVersion;
    test.info().annotations.push({ type: "mcp-protocol-version", description: String(state.protocolVersion) });
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(state.protocolVersion);

    const list = await rpc(state.accessToken, "tools/list", {}, state.protocolVersion);
    expect(list.status).toBe(200);
    const names = (list.body?.result?.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(TOOL_NAMES);
  });

  test("M-1: search_events finds the seeded event through the exchanged token", async () => {
    const res = await callTool(state.accessToken, "search_events", { available: true, limit: 100 });
    expect(res.status).toBe(200);
    expect(res.body?.result?.isError).toBeFalsy();
    const items = res.body?.result?.structuredContent?.items as { id: string; title: string }[];
    expect(items.map((t) => t.id)).toContain(state.ticketId);
  });

  test("M-1: create_order twice with identical arguments yields one order (replayed: true)", async () => {
    const args = { ticketId: state.ticketId, quantity: 1 };
    const first = await callTool(state.accessToken, "create_order", args);
    expect(first.status).toBe(200);
    expect(first.body?.result?.isError).toBeFalsy();
    const order = first.body?.result?.structuredContent;
    expect(order.replayed).toBe(false);
    state.orderId = order.id;

    // A host that lost the first response retries: the derived Idempotency-Key must replay it.
    const second = await callTool(state.accessToken, "create_order", args);
    expect(second.body?.result?.isError).toBeFalsy();
    expect(second.body?.result?.structuredContent.replayed).toBe(true);
    expect(second.body?.result?.structuredContent.id).toBe(state.orderId);

    const mine = await callTool(state.accessToken, "list_my_orders", {});
    const orders = mine.body?.result?.structuredContent?.items as { id: string }[];
    expect(orders.filter((o) => o.id === state.orderId)).toHaveLength(1);
    expect(orders).toHaveLength(1);
  });

  test("M-1: pay_for_order_with_default charges the saved default method", async () => {
    test.skip(!state.paymentMethodSaved, state.paymentSkipReason || "no saved payment method");
    const res = await callTool(state.accessToken, "pay_for_order_with_default", {
      orderId: state.orderId,
    });
    expect(res.status).toBe(200);
    expect(res.body?.result?.isError).toBeFalsy();
    const payment = res.body?.result?.structuredContent?.payment;
    expect(payment.orderId).toBe(state.orderId);
    // payment-service mock mode: charge() completes immediately (observed status "completed").
    expect(payment.status).toBe("completed");
    // The order moves to COMPLETE asynchronously (payment event over Kafka, OrderService.java:524),
    // so poll the read tool rather than asserting once.
    await expect
      .poll(
        async () => {
          const o = await callTool(state.accessToken, "get_order", { orderId: state.orderId });
          return o.body?.result?.structuredContent?.status;
        },
        { timeout: 30_000 },
      )
      .toBe("complete");

    // The same payment is readable through the payments:read tool.
    const read = await callTool(state.accessToken, "get_payment", { paymentId: payment.id });
    expect(read.body?.result?.isError).toBeFalsy();
    expect(read.body?.result?.structuredContent?.payment?.orderId).toBe(state.orderId);
  });

  test("M-1 edge (C-10): the MCP-audience token is refused on the REST API", async () => {
    const res = await fetch(`${KONG_URL}/api/orders`, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    expect(res.status).toBe(401);
    // The audience rule specifically, not some other 401 (jwt-scope.lua).
    expect(await res.json()).toMatchObject({
      error: "invalid_token",
      error_description: "token audience not accepted",
    });
    expect(res.headers.get("www-authenticate") ?? "").toContain("token audience not accepted");
  });

  test("M-1 edge (C-6): a token without orders:create gets a step-up 403 naming the scope", async () => {
    const session = await signupViaApi();
    const readOnly = await obtainOAuthAccessToken(session.accessToken, "tickets:read", MCP_URL);

    const res = await callTool(readOnly.accessToken, "create_order", {
      ticketId: state.ticketId,
      quantity: 1,
    });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toMatch(/scope="[^"]*\borders:create\b[^"]*"/);
    // Held scopes are kept in the challenge so a re-consent does not drop them.
    expect(challenge).toMatch(/scope="[^"]*\btickets:read\b[^"]*"/);
    expect(challenge).toContain("resource_metadata=");
  });
});
