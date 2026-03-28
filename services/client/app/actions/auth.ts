"use server";
// app/actions/auth.ts — Server Actions for authentication flows.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parse } from "set-cookie-parser";
import { ApiError } from "@/lib/api";

const base = () =>
  (process.env.INTERNAL_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

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

    // Forward the httpOnly token cookie from auth-service to the browser.
    // Use set-cookie-parser for robust parsing (S-08) and set maxAge to match
    // the 15-minute JWT lifetime (S-07).
    const setCookieHeader = res.headers.get("set-cookie");
    if (setCookieHeader) {
      const cookieStore = await cookies();
      const parsed = parse(setCookieHeader, { map: true });
      const tokenEntry = parsed["token"];
      if (tokenEntry?.value) {
        cookieStore.set("token", tokenEntry.value, {
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          maxAge: 900, // 15 minutes — matches JWT expiry (S-07)
        });
      }
    }
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

    // Forward the httpOnly token cookie from auth-service to the browser.
    // Use set-cookie-parser for robust parsing (S-08) and set maxAge to match
    // the 15-minute JWT lifetime (S-07).
    const setCookieHeader = res.headers.get("set-cookie");
    if (setCookieHeader) {
      const cookieStore = await cookies();
      const parsed = parse(setCookieHeader, { map: true });
      const tokenEntry = parsed["token"];
      if (tokenEntry?.value) {
        cookieStore.set("token", tokenEntry.value, {
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          maxAge: 900, // 15 minutes — matches JWT expiry (S-07)
        });
      }
    }
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: "An unexpected error occurred." };
  }

  redirect("/");
}

// ─── Signout ──────────────────────────────────────────────────────────────────

export async function signout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete("token");
  redirect("/auth/signin");
}
