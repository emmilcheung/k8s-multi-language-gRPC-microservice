// Pure waiting-room gate logic — no Next.js types, fully unit-testable.
// Validates the HMAC-SHA256 admission token issued by the queue-service.
import { isGatedPath } from "./gated-path";

/** Sub is absent on the admission token /api/claim returns, and set on the
 *  purchase pass redeem returns (the account it is bound to; Kong checks it). */
export interface AdmissionPayload { Eid: string; Mid: string; Iat: number; Exp: number; Nonce: string; Sub?: string | null; }

export type Decision =
  | { kind: "pass" }
  | { kind: "redirect-queue"; location: string }
  | { kind: "login"; location: string; token: string; expSec: number }
  | { kind: "accept"; cleanUrl: string; token: string };

export interface GateInput {
  armed: boolean; eventId: string; secret: string; queueUrl: string;
  /** Full absolute URL of the incoming request — used as the post-admission return target
   *  so the queue page can cross-domain redirect back to the main site. */
  fullUrl: string;
  pathWithQuery: string; qpass: string | null; passCookie: string | null; nowSec: number;
  /** Admission token kept in a cookie while the visitor signs in, so it never
   *  sits in the sign-in page's URL (history, logs, Referer). */
  admitCookie: string | null;
  /** Whether the visitor has a login cookie; redeeming binds the pass to that account. */
  loggedIn: boolean;
}

// Visitors sent to sign in before redeeming must be able to reach these pages.
const UNGATED_PATHS = new Set(["/auth/signin", "/auth/signup"]);

function b64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyAdmission(token: string, secret: string): Promise<AdmissionPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts[0]));
  if (!timingSafeEqual(bytesToB64url(new Uint8Array(sig)), parts[1])) return null;
  try {
    const json = new TextDecoder().decode(b64urlToBytes(parts[0]));
    return JSON.parse(json) as AdmissionPayload;
  } catch {
    return null;
  }
}

function valid(p: AdmissionPayload | null, eventId: string, nowSec: number): boolean {
  return p !== null && p.Eid === eventId && p.Exp > nowSec;
}

export async function gateDecision(i: GateInput): Promise<Decision> {
  if (!i.armed) return { kind: "pass" };
  if (UNGATED_PATHS.has(i.pathWithQuery.split("?")[0])) return { kind: "pass" };

  if (i.qpass) {
    const p = await verifyAdmission(i.qpass, i.secret);
    if (p && valid(p, i.eventId, i.nowSec)) {
      const cleanUrl = stripQpass(i.pathWithQuery);
      if (!i.loggedIn) {
        return {
          kind: "login", location: `/auth/signin?next=${encodeURIComponent(cleanUrl)}`,
          token: i.qpass, expSec: p.Exp,
        };
      }
      return { kind: "accept", cleanUrl, token: i.qpass };
    }
  }

  if (i.admitCookie && i.loggedIn) {
    const p = await verifyAdmission(i.admitCookie, i.secret);
    if (valid(p, i.eventId, i.nowSec)) return { kind: "accept", cleanUrl: i.pathWithQuery, token: i.admitCookie };
  }

  // Only the armed event's purchase pages need a pass. An admission link or kept
  // admission above is still redeemed wherever it lands, so it is never dropped.
  if (!isGatedPath(i.pathWithQuery.split("?")[0], i.eventId)) return { kind: "pass" };

  if (i.passCookie) {
    const p = await verifyAdmission(i.passCookie, i.secret);
    if (valid(p, i.eventId, i.nowSec) && typeof p?.Sub === "string" && p.Sub) return { kind: "pass" };
  }

  const target = encodeURIComponent(stripQpass(i.fullUrl));
  return { kind: "redirect-queue", location: `${i.queueUrl}/wait?e=${i.eventId}&target=${target}` };
}

function stripQpass(pathWithQuery: string): string {
  const [path, query] = pathWithQuery.split("?");
  if (!query) return path;
  const kept = query.split("&").filter((kv) => !kv.startsWith("qpass="));
  return kept.length ? `${path}?${kept.join("&")}` : path;
}

export type RedeemResult = { kind: "ok"; pass: string } | { kind: "login" } | { kind: "failed" };

/** Exchanges an admission token for a purchase pass bound to the logged-in
 *  account. Goes through the gateway (`/api/queue/redeem`), which validates the
 *  access token and signs the user id for queue-service. A repeat by the same
 *  account returns the same pass. Fails closed on anything unexpected. */
export async function redeemAdmission(
  apiBase: string, token: string, accessToken: string, fetchImpl: typeof fetch = fetch,
): Promise<RedeemResult> {
  try {
    const r = await fetchImpl(`${apiBase}/api/queue/redeem`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ token }),
    });
    if (r.status === 401) return { kind: "login" };
    if (!r.ok) return { kind: "failed" };
    const body = (await r.json()) as { pass?: unknown };
    return typeof body.pass === "string" && body.pass ? { kind: "ok", pass: body.pass } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}
