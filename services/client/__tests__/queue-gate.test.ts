import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { verifyAdmission, gateDecision, type AdmissionPayload } from "@/lib/queue/gate";

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
const payload = (over: Partial<AdmissionPayload> = {}): AdmissionPayload =>
  ({ Eid: "E1", Mid: "m1", Iat: 1000, Exp: 9999999999, Nonce: "n", ...over });

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
    pathWithQuery: "/tickets/123", qpass: null as string | null,
    passCookie: null as string | null, nowSec: 2000,
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
      expect(d.location).toContain("target=%2Ftickets%2F123");
    }
  });
  it("accepts a valid qpass and strips it from the URL", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, pathWithQuery: "/tickets/123?qpass=" + t, qpass: t });
    expect(d.kind).toBe("accept");
    if (d.kind === "accept") {
      expect(d.cleanUrl).toBe("/tickets/123");
      expect(d.cookieValue).toBe(t);
    }
  });
  it("passes when a valid pass cookie is present", async () => {
    const t = await sign(payload());
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("pass");
  });
  it("redirects to queue when the pass cookie is expired", async () => {
    const t = await sign(payload({ Exp: 1500 })); // < nowSec 2000
    const d = await gateDecision({ ...base, passCookie: t });
    expect(d.kind).toBe("redirect-queue");
  });
});
