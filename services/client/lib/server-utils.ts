/**
 * Shared server-side utilities for Next.js Server Actions.
 *
 * These helpers are imported by app/actions/*.ts.  They must NOT be marked
 * "use server" — they are plain utility functions, not Server Actions.
 */

import { cookies } from "next/headers";
import { traceHeaders } from "@/lib/tracing";
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

/**
 * Returns the base URL for the internal API gateway.
 * Uses INTERNAL_API_URL (cluster-internal Kong URL) in production/staging,
 * falls back to NEXT_PUBLIC_API_URL in local dev, and finally to localhost.
 */
export const base = (): string =>
  (
    process.env.INTERNAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  ).replace(/\/$/, "");

interface RequestWithCookies {
  cookies: {
    get(name: string): { value: string } | undefined;
  };
  headers?: {
    get(name: string): string | null;
  };
}

interface SessionCookies {
  token?: string;
  refreshToken?: string;
}

function decodeJwtExpiryEpochSeconds(token: string): number | null {
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export function readCurrentUserIdFromToken(token?: string): string | null {
  if (!token) return null;
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as {
      sub?: string;
    };
    return payload.sub ?? null;
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

function buildCookieHeader(session: SessionCookies): string | undefined {
  const pairs: string[] = [];
  if (session.token) {
    pairs.push(`${ACCESS_TOKEN_COOKIE}=${session.token}`);
  }
  if (session.refreshToken) {
    pairs.push(`${REFRESH_TOKEN_COOKIE}=${session.refreshToken}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

function readSetCookieValues(rawSetCookie: string | string[] | null): SessionCookies {
  const parsed = parseAuthCookies(rawSetCookie);

  return {
    token: parsed[ACCESS_TOKEN_COOKIE]?.value,
    refreshToken: parsed[REFRESH_TOKEN_COOKIE]?.value,
  };
}

async function persistSessionCookies(rawSetCookie: string | string[] | null): Promise<SessionCookies> {
  const cookieValues = readSetCookieValues(rawSetCookie);
  const cookieStore = await cookies();
  const parsed = parseAuthCookies(rawSetCookie);

  const tokenCookie = parsed[ACCESS_TOKEN_COOKIE];
  if (cookieValues.token && tokenCookie) {
    cookieStore.set(
      ACCESS_TOKEN_COOKIE,
      cookieValues.token,
      toCookieOptions(tokenCookie, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: ACCESS_COOKIE_SAME_SITE,
        path: ACCESS_COOKIE_PATH,
      })
    );
  }

  const refreshCookie = parsed[REFRESH_TOKEN_COOKIE];
  if (cookieValues.refreshToken && refreshCookie) {
    cookieStore.set(
      REFRESH_TOKEN_COOKIE,
      cookieValues.refreshToken,
      toCookieOptions(refreshCookie, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: REFRESH_COOKIE_SAME_SITE,
        path: REFRESH_COOKIE_PATH,
      })
    );
  }

  return cookieValues;
}

async function readSessionCookies(request?: RequestWithCookies): Promise<SessionCookies> {
  if (request && typeof request.cookies?.get === "function") {
    return {
      token: request.cookies.get(ACCESS_TOKEN_COOKIE)?.value,
      refreshToken: request.cookies.get(REFRESH_TOKEN_COOKIE)?.value,
    };
  }

  const cookieStore = await cookies();
  return {
    token: cookieStore.get(ACCESS_TOKEN_COOKIE)?.value,
    refreshToken: cookieStore.get(REFRESH_TOKEN_COOKIE)?.value,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<string | undefined> {
  const refreshCookieHeader = buildCookieHeader({ refreshToken });

  const res = await fetch(`${base()}/api/auth/refresh`, {
    method: "POST",
    cache: "no-store",
    headers: {
      ...traceHeaders(),
      ...(refreshCookieHeader ? { Cookie: refreshCookieHeader } : {}),
    },
  });

  if (!res.ok) {
    if (res.status === 401) {
      const cookieStore = await cookies();
      cookieStore.delete(ACCESS_TOKEN_COOKIE);
      cookieStore.delete(REFRESH_TOKEN_COOKIE);
    }
    return undefined;
  }

  const headersWithSetCookie = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const rawSetCookie =
    typeof headersWithSetCookie.getSetCookie === "function"
      ? headersWithSetCookie.getSetCookie()
      : res.headers.get("set-cookie");

  const persisted = await persistSessionCookies(rawSetCookie);
  return persisted.token;
}

export async function getValidAccessToken(request?: RequestWithCookies): Promise<string | undefined> {
  const { token, refreshToken } = await readSessionCookies(request);

  if (token && !isTokenExpiringSoon(token)) {
    return token;
  }

  if (!refreshToken) {
    return token;
  }

  const refreshedToken = await refreshAccessToken(refreshToken).catch(() => undefined);
  return refreshedToken ?? token;
}

/**
 * Returns fetch headers that forward the auth token cookie to the upstream API.
 * Reads the "token" cookie from the current request context.
 * Optionally accepts a NextRequest to extract headers from (for use in Route Handlers).
 */
export async function authHeaders(request?: RequestWithCookies): Promise<HeadersInit> {
  const token = await getValidAccessToken(request);

  return {
    "Content-Type": "application/json",
    ...traceHeaders(),
    ...(token ? { Cookie: `${ACCESS_TOKEN_COOKIE}=${token}` } : {}),
  };
}

/**
 * Returns fetch headers for auth session APIs that require both access and
 * refresh cookies to compute current-session state and clear cookies on revoke.
 */
export async function authSessionHeaders(request?: RequestWithCookies): Promise<Record<string, string>> {
  const token = await getValidAccessToken(request);

  // Prefer cookie values from the mutable server cookie store after refresh.
  const currentCookies = await readSessionCookies();
  const requestCookies = request ? await readSessionCookies(request) : currentCookies;
  const refreshToken = currentCookies.refreshToken ?? requestCookies.refreshToken;

  const cookieHeader = buildCookieHeader({
    token,
    refreshToken,
  });

  return {
    "Content-Type": "application/json",
    ...traceHeaders(),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}
