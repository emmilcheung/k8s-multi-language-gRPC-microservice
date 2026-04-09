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

export async function middleware(request: NextRequest) {
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
