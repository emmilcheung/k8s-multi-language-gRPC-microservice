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

  redirect("/");
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
