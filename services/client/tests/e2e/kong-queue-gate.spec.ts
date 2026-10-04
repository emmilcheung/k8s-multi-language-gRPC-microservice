/**
 * kong-queue-gate.spec.ts: the waiting room covers every way to reserve.
 *
 * When armed, REST order creation (the path agents use) needs a qq_pass just
 * like the GraphQL purchase mutations, and a genuine pass must be admitted
 * rather than crash the gateway. A pass works only for the account it was
 * redeemed by, so one buyer's pass cannot be handed to another. When disarmed,
 * the gate must be inert.
 * The armed block runs only with E2E_KONG_QUEUE_ARMED=1 against a gateway
 * rendered with QUEUE_GATE_ARMED: "true".
 */
import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { KONG_URL, signupViaApi } from "./_helpers/oauth";

const ARMED = process.env.E2E_KONG_QUEUE_ARMED === "1";
const SECRET = process.env.E2E_QUEUE_HMAC_SECRET ?? "dev-secret-change-me-32-chars-minimum";
const EVENT = process.env.E2E_QUEUE_EVENT_ID ?? "E2E";

const subOf = (jwt: string): string =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).sub;

// Shaped like the pass queue-service returns from redeem.
function pass(sub: string, secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { Eid: EVENT, Mid: "m", Iat: now, Exp: now + 900, Nonce: "n", Sub: sub };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${createHmac("sha256", secret).update(b64).digest("base64url")}`;
}

let session: string;
let sub: string;
test.beforeAll(async () => {
  session = (await signupViaApi()).accessToken;
  sub = subOf(session);
});

const createOrder = (qqPass?: string) =>
  fetch(`${KONG_URL}/api/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `token=${session}` + (qqPass ? `; qq_pass=${qqPass}` : ""),
    },
    body: "{}",
  });

test.describe("disarmed gate", () => {
  test.skip(ARMED, "runs against the default (disarmed) gateway");

  test("REST order creation needs no pass", async () => {
    const res = await createOrder();
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });
});

test.describe("armed gate", () => {
  test.skip(!ARMED, "set E2E_KONG_QUEUE_ARMED=1 against an armed gateway");

  test("REST order creation without a pass is sent to the waiting room", async () => {
    const res = await createOrder();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "waiting room: pass required" });
  });

  test("a forged pass is refused", async () => {
    const res = await createOrder(pass(sub, "not-the-secret-not-the-secret-000"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "waiting room: invalid pass" });
  });

  test("a genuine pass is admitted instead of crashing the gateway", async () => {
    const res = await createOrder(pass(sub));
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });

  test("a pass redeemed by another account is refused", async () => {
    const res = await createOrder(pass(subOf((await signupViaApi()).accessToken)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "waiting room: pass belongs to another account" });
  });

  test("a GraphQL purchase without a pass is sent to the waiting room", async () => {
    const res = await fetch(`${KONG_URL}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `token=${session}` },
      body: JSON.stringify({ query: 'mutation { createOrder(ticketId: "x") { id } }' }),
    });
    expect(res.status).toBe(403);
  });

  test("GraphQL purchase with a genuine pass is admitted", async () => {
    const res = await fetch(`${KONG_URL}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `token=${session}; qq_pass=${pass(sub)}` },
      body: JSON.stringify({ query: 'mutation { createOrder(ticketId: "x") { id } }' }),
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(403);
  });

  test("REST order reads stay open while armed", async () => {
    const res = await fetch(`${KONG_URL}/api/orders`, { headers: { Cookie: `token=${session}` } });
    expect(res.status).toBe(200);
  });
});
