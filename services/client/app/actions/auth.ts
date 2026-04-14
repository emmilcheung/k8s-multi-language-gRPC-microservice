"use server";
// app/actions/auth.ts — Server Actions for authentication flows.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError } from "@/lib/api";
import { base } from "@/lib/server-utils";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  ACCESS_COOKIE_PATH,
  REFRESH_COOKIE_PATH,
  ACCESS_COOKIE_SAME_SITE,
  REFRESH_COOKIE_SAME_SITE,
  parseAuthCookies,
  toCookieOptions,
} from "@/lib/session-cookies";

async function persistAuthCookies(setCookieHeader: string | null): Promise<void> {
  if (!setCookieHeader) return;

  const cookieStore = await cookies();
  const parsed = parseAuthCookies(setCookieHeader);

  const tokenEntry = parsed[ACCESS_TOKEN_COOKIE];
  if (tokenEntry?.value) {
    cookieStore.set(
      ACCESS_TOKEN_COOKIE,
      tokenEntry.value,
      toCookieOptions(tokenEntry, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: ACCESS_COOKIE_SAME_SITE,
        path: ACCESS_COOKIE_PATH,
      })
    );
  }

  const refreshEntry = parsed[REFRESH_TOKEN_COOKIE];
  if (refreshEntry?.value) {
    cookieStore.set(
      REFRESH_TOKEN_COOKIE,
      refreshEntry.value,
      toCookieOptions(refreshEntry, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: REFRESH_COOKIE_SAME_SITE,
        path: REFRESH_COOKIE_PATH,
      })
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Guard against open-redirect attacks on the ?next parameter.
 * Allows:
 *   - Relative paths starting with / (same-origin Next.js routes)
 *   - Absolute URLs whose origin matches the configured Kong proxy
 *     (so MCP OAuth callbacks can return the browser to /oauth/authorize)
 *
 * In development, any localhost/127.0.0.1 origin is accepted since the Kong
 * proxy and the Next.js app both run on localhost with different ports.
 */
function isSafeRedirect(url: string | null | undefined): url is string {
  if (!url) return false;
  // Relative path — same origin, always safe
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const parsed = new URL(url);
    if (process.env.NODE_ENV !== "production") {
      return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    }
    // Production: only allow the configured Kong gateway origin
    const kongUrl = process.env.NEXT_PUBLIC_API_URL ?? "";
    if (!kongUrl) return false;
    const kongOrigin = new URL(kongUrl).origin;
    return parsed.origin === kongOrigin;
  } catch {
    return false;
  }
}

// ─── Signup ───────────────────────────────────────────────────────────────────

export interface AuthState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

export async function signup(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // Basic email format validation (S-14)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  try {
    const res = await fetch(`${base()}/api/users/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body?.error?.message ?? "Signup failed." };
    }

    // Forward auth cookies from auth-service to browser (access + refresh).
    await persistAuthCookies(res.headers.get("set-cookie"));
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "An unexpected error occurred." };
  }

  redirect("/");
}

// ─── Signin ───────────────────────────────────────────────────────────────────

export async function signin(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  // Present when the user was redirected here mid-OAuth2 flow (e.g. from MCP server).
  const next = formData.get("next") as string | null;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // Basic email format validation (S-14)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  try {
    const res = await fetch(`${base()}/api/users/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body?.error?.message ?? "Signin failed." };
    }

    // Forward auth cookies from auth-service to browser (access + refresh).
    await persistAuthCookies(res.headers.get("set-cookie"));
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "An unexpected error occurred." };
  }

  // After OAuth2-initiated signin, return the browser to the authorize endpoint.
  // Guard against open-redirect: only allow trusted origins.
  redirect(isSafeRedirect(next) ? next : "/");
}

// ─── Signout ──────────────────────────────────────────────────────────────────

export async function signout(): Promise<void> {
  const cookieStore = await cookies();

  const token = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_TOKEN_COOKIE)?.value;
  const cookiePairs: string[] = [];
  if (token) cookiePairs.push(`${ACCESS_TOKEN_COOKIE}=${token}`);
  if (refreshToken) cookiePairs.push(`${REFRESH_TOKEN_COOKIE}=${refreshToken}`);

  // Best-effort upstream signout to revoke refresh token + blacklist access token.
  await fetch(`${base()}/api/users/signout`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(cookiePairs.length > 0 ? { Cookie: cookiePairs.join("; ") } : {}),
    },
  }).catch(() => undefined);

  cookieStore.delete(ACCESS_TOKEN_COOKIE);
  cookieStore.delete(REFRESH_TOKEN_COOKIE);
  redirect("/auth/signin");
}
