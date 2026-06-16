import { NextRequest, NextResponse } from "next/server";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  REFRESH_SKEW_SECONDS,
  ACCESS_COOKIE_PATH,
  REFRESH_COOKIE_PATH,
  ACCESS_COOKIE_SAME_SITE,
  REFRESH_COOKIE_SAME_SITE,
  parseAuthCookies,
  toCookieOptions,
} from "@/lib/session-cookies";
import { gateDecision } from "@/lib/queue/gate";

const QUEUE_PASS_COOKIE = process.env.QUEUE_PASS_COOKIE || "qq_pass";

// Virtual waiting room gate. Returns a response when the gate intercepts
// (redirect to the waiting room, or accept a qpass), or null to pass through
// (gate disarmed, misconfigured, or visitor already admitted).
async function applyQueueGate(request: NextRequest): Promise<NextResponse | null> {
  if (process.env.QUEUE_GATE_ARMED !== "true") return null;

  const eventId = process.env.QUEUE_EVENT_ID || "";
  const secret = process.env.QUEUE_HMAC_SECRET || "";
  const queueUrl = process.env.QUEUE_URL || "";
  if (!eventId || !secret || !queueUrl) return null; // misconfigured → fail open

  const url = request.nextUrl;
  const decision = await gateDecision({
    armed: true, eventId, secret, queueUrl,
    pathWithQuery: url.pathname + url.search,
    qpass: url.searchParams.get("qpass"),
    passCookie: request.cookies.get(QUEUE_PASS_COOKIE)?.value ?? null,
    nowSec: Math.floor(Date.now() / 1000),
  });

  switch (decision.kind) {
    case "pass":
      return null;
    case "redirect-queue":
      return NextResponse.redirect(decision.location, 302);
    case "accept": {
      const res = NextResponse.redirect(new URL(decision.cleanUrl, request.url), 302);
      res.cookies.set(QUEUE_PASS_COOKIE, decision.cookieValue, {
        httpOnly: true, sameSite: "lax", path: "/",
        secure: process.env.NODE_ENV === "production",
      });
      return res;
    }
  }
}

function getApiBase(): string {
  return (
    process.env.INTERNAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  ).replace(/\/$/, "");
}

function decodeJwtExpiryEpochSeconds(token: string): number | null {
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;

    const base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { exp?: number };

    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function isTokenExpiringSoon(token: string): boolean {
  const exp = decodeJwtExpiryEpochSeconds(token);
  if (!exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp <= now + REFRESH_SKEW_SECONDS;
}

function persistRefreshedCookies(response: NextResponse, setCookieHeader: string | null): void {
  if (!setCookieHeader) return;

  const parsed = parseAuthCookies(setCookieHeader);

  const token = parsed[ACCESS_TOKEN_COOKIE]?.value;
  if (token) {
    response.cookies.set({
      name: ACCESS_TOKEN_COOKIE,
      value: token,
      ...toCookieOptions(parsed[ACCESS_TOKEN_COOKIE], {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: ACCESS_COOKIE_SAME_SITE,
        path: ACCESS_COOKIE_PATH,
      }),
    });
  }

  const refreshToken = parsed[REFRESH_TOKEN_COOKIE]?.value;
  if (refreshToken) {
    response.cookies.set({
      name: REFRESH_TOKEN_COOKIE,
      value: refreshToken,
      ...toCookieOptions(parsed[REFRESH_TOKEN_COOKIE], {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: REFRESH_COOKIE_SAME_SITE,
        path: REFRESH_COOKIE_PATH,
      }),
    });
  }
}

export async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const traceparent = request.headers.get("traceparent") ?? request.headers.get("x-b3-traceid");

  if (traceparent) {
    const traceId = traceparent.includes("-") ? traceparent.split("-")[1] : traceparent;
    if (traceId) {
      response.headers.set("x-trace-id", traceId);
    }
  }

  const path = request.nextUrl.pathname;
  const isStaticAsset =
    path.startsWith("/_next/") ||
    path.startsWith("/favicon") ||
    path.startsWith("/robots.txt") ||
    path.startsWith("/sitemap.xml");

  if (isStaticAsset) {
    return response;
  }

  // Waiting-room gate runs before auth refresh: an un-admitted visitor is sent
  // to the queue and never reaches the app (or its token-refresh path).
  const gateResponse = await applyQueueGate(request);
  if (gateResponse) {
    return gateResponse;
  }

  const token = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;

  if (!refreshToken) {
    return response;
  }

  if (token && !isTokenExpiringSoon(token)) {
    return response;
  }

  try {
    const refreshResponse = await fetch(`${getApiBase()}/api/auth/refresh`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Cookie: `${REFRESH_TOKEN_COOKIE}=${refreshToken}`,
      },
    });

    if (refreshResponse.ok) {
      persistRefreshedCookies(response, refreshResponse.headers.get("set-cookie"));
      return response;
    }

    if (refreshResponse.status === 401) {
      response.cookies.delete(ACCESS_TOKEN_COOKIE);
      response.cookies.delete(REFRESH_TOKEN_COOKIE);
    }
  } catch {
    // Non-fatal: if refresh infra is briefly unavailable, continue request.
  }

  return response;
}

export const config = {
  matcher: ["/:path*"],
};