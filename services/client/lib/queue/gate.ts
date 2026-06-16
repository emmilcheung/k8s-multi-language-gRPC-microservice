// Pure waiting-room gate logic — no Next.js types, fully unit-testable.
// Validates the HMAC-SHA256 admission token issued by the queue-service.

export interface AdmissionPayload { Eid: string; Mid: string; Iat: number; Exp: number; Nonce: string; }

export type Decision =
  | { kind: "pass" }
  | { kind: "redirect-queue"; location: string }
  | { kind: "accept"; cleanUrl: string; cookieValue: string };

export interface GateInput {
  armed: boolean; eventId: string; secret: string; queueUrl: string;
  pathWithQuery: string; qpass: string | null; passCookie: string | null; nowSec: number;
}

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

  if (i.qpass) {
    const p = await verifyAdmission(i.qpass, i.secret);
    if (valid(p, i.eventId, i.nowSec)) {
      const cleanUrl = stripQpass(i.pathWithQuery);
      return { kind: "accept", cleanUrl, cookieValue: i.qpass };
    }
  }

  if (i.passCookie) {
    const p = await verifyAdmission(i.passCookie, i.secret);
    if (valid(p, i.eventId, i.nowSec)) return { kind: "pass" };
  }

  const target = encodeURIComponent(i.pathWithQuery);
  return { kind: "redirect-queue", location: `${i.queueUrl}/wait?e=${i.eventId}&target=${target}` };
}

function stripQpass(pathWithQuery: string): string {
  const [path, query] = pathWithQuery.split("?");
  if (!query) return path;
  const kept = query.split("&").filter((kv) => !kv.startsWith("qpass="));
  return kept.length ? `${path}?${kept.join("&")}` : path;
}
