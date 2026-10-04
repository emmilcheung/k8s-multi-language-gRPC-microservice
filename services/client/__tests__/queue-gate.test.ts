import { describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { verifyAdmission, gateDecision, redeemAdmission, type AdmissionPayload } from "@/lib/queue/gate";

const SECRET = "k".repeat(32);

// Sign a token exactly like the .NET TokenService: base64url(json)."base64url(hmac)".
function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sign(payload: AdmissionPayload, secret = SECRET): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}
// What /api/claim returns: not yet tied to an account.
const payload = (over: Partial<AdmissionPayload> = {}): AdmissionPayload =>
  ({ Eid: "E1", Mid: "m1", Iat: 1000, Exp: 9999999999, Nonce: "n", ...over });
// What redeem returns: the purchase pass, bound to the account that redeemed it.
const bound = (over: Partial<AdmissionPayload> = {}): AdmissionPayload => payload({ Sub: "user-a", ...over });

describe("verifyAdmission", () => {
  it("accepts a correctly signed token and returns the payload", async () => {
    const p = await verifyAdmission(await sign(payload()), SECRET);
    expect(p?.Eid).toBe("E1");
  });
  it("rejects a token signed with a different secret", async () => {
    const t = await sign(payload(), "z".repeat(32));
    expect(await verifyAdmission(t, SECRET)).toBeNull();
  });
  it("rejects a tampered body", async () => {
    const t = await sign(payload());
    expect(await verifyAdmission("x" + t, SECRET)).toBeNull();
  });
  it("rejects malformed tokens", async () => {
    for (const bad of ["", "nodot", "a.b.c"]) expect(await verifyAdmission(bad, SECRET)).toBeNull();
  });
});

describe("gateDecision", () => {
  const base = {
    armed: true, eventId: "E1", secret: SECRET, queueUrl: "http://q:4100",
    fullUrl: "http://app:4000/tickets/123",
    pathWithQuery: "/tickets/123", qpass: null as string | null,
    passCookie: null as string | null, nowSec: 2000, loggedIn: true,
    admitCookie: null as string | null,
  };

  it("passes through when the gate is disarmed", async () => {
    const d = await gateDecision({ ...base, armed: false });
    expect(d.kind).toBe("pass");
  });
  it("redirects to the queue when no credential is present", async () => {
    const d = await gateDecision(base);
    expect(d.kind).toBe("redirect-queue");
    if (d.kind === "redirect-queue") {
      expect(d.location).toContain("http://q:4100/wait?e=E1");
      expect(d.location).toContain("target=http%3A%2F%2Fapp%3A4000%2Ftickets%2F123");
    }
  });
  it("accepts a valid qpass from a logged-in visitor and strips it from the URL", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, pathWithQuery: "/tickets/123?qpass=" + t, qpass: t });
    expect(d.kind).toBe("accept");
    if (d.kind === "accept") {
      expect(d.cleanUrl).toBe("/tickets/123");
      expect(d.token).toBe(t);
    }
  });
  // The pass is bound to an account when it is redeemed, so the buyer must be
  // logged in first. The admission token is handed back for a cookie, not kept
  // in ?next: the sign-in page renders, and its URL ends up in history, access
  // logs and the Referer of everything it loads.
  it("sends a visitor who is not logged in to sign in without the token in the URL", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, pathWithQuery: "/tickets/123?qpass=" + t, qpass: t, loggedIn: false });
    expect(d.kind).toBe("login");
    if (d.kind === "login") {
      expect(d.location).toBe("/auth/signin?next=" + encodeURIComponent("/tickets/123"));
      expect(d.token).toBe(t);
      expect(d.expSec).toBe(payload().Exp);
    }
  });
  // Back from sign-in, the kept token is redeemed so the buyer does not queue again.
  it("redeems the kept admission token once the visitor has signed in", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, admitCookie: t });
    expect(d).toEqual({ kind: "accept", cleanUrl: "/tickets/123", token: t });
  });
  it("ignores a kept admission token until the visitor has signed in", async () => {
    const t = await sign(payload());
    expect((await gateDecision({ ...base, admitCookie: t, loggedIn: false })).kind).toBe("redirect-queue");
  });
  it("ignores a kept admission token that has expired or is forged", async () => {
    const expired = await sign(payload({ Exp: 1500 }));
    expect((await gateDecision({ ...base, admitCookie: expired })).kind).toBe("redirect-queue");
    expect((await gateDecision({ ...base, admitCookie: "a.b" })).kind).toBe("redirect-queue");
  });
  // A token that failed to verify must not be carried to the queue page either.
  it("drops an unusable qpass from the queue page's return target", async () => {
    const d = await gateDecision({
      ...base, fullUrl: "http://app:4000/tickets/123?x=1&qpass=junk", pathWithQuery: "/tickets/123?x=1&qpass=junk", qpass: "junk",
    });
    expect(d.kind).toBe("redirect-queue");
    if (d.kind === "redirect-queue") {
      expect(d.location).not.toContain("qpass");
      expect(d.location).toContain(encodeURIComponent("http://app:4000/tickets/123?x=1"));
    }
  });
  // Every page is gated while armed; if sign-in were too, the visitor sent
  // there above would be bounced straight back to the queue.
  it("does not gate the sign-in and sign-up pages", async () => {
    for (const path of ["/auth/signin", "/auth/signup", "/auth/signin?next=%2Ftickets%2F123"]) {
      expect((await gateDecision({ ...base, pathWithQuery: path, loggedIn: false })).kind).toBe("pass");
    }
    expect((await gateDecision({ ...base, pathWithQuery: "/auth/signin-elsewhere" })).kind).toBe("redirect-queue");
  });
  it("passes when a valid pass cookie is present", async () => {
    const t = await sign(bound());
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("pass");
  });
  // Only a redeemed pass names an account; an admission token copied into the
  // cookie must not stand in for one.
  it("does not treat an unredeemed admission token as a pass", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("redirect-queue");
  });
  it("redirects to queue when the pass cookie is expired", async () => {
    const t = await sign(bound({ Exp: 1500 })); // < nowSec 2000
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("redirect-queue");
  });
  it("redirects to queue when the pass cookie is for another event", async () => {
    const t = await sign(bound({ Eid: "E2" }));
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("redirect-queue");
  });
});

// Redeem goes through Kong, not straight to the queue host: Kong validates the
// login token and signs the user id, which is what binds the pass to the buyer.
describe("redeemAdmission", () => {
  const reply = (status: number, body: unknown) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("posts the token through the gateway with the access token and returns the bound pass", async () => {
    const fetchImpl = reply(200, { pass: "bound.pass" });
    const r = await redeemAdmission("http://kong:8000", "adm.token", "jwt-123", fetchImpl);
    expect(r).toEqual({ kind: "ok", pass: "bound.pass" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://kong:8000/api/queue/redeem");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt-123");
    expect(JSON.parse(init.body)).toEqual({ token: "adm.token" });
  });
  it("asks for a login when the gateway does not accept the session", async () => {
    expect(await redeemAdmission("http://k", "t", "stale", reply(401, {}))).toEqual({ kind: "login" });
  });
  it("fails on a refusal, an answer without a pass, or a network error", async () => {
    expect((await redeemAdmission("http://k", "t", "j", reply(403, { error: "x" }))).kind).toBe("failed");
    expect((await redeemAdmission("http://k", "t", "j", reply(409, { error: "x" }))).kind).toBe("failed");
    expect((await redeemAdmission("http://k", "t", "j", reply(200, { ok: true }))).kind).toBe("failed");
    const down = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await redeemAdmission("http://k", "t", "j", down)).kind).toBe("failed");
  });
});
