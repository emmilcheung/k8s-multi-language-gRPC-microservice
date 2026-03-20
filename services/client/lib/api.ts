// lib/api.ts
// Server-side and client-side API helpers.
// Server Components call serverApi (uses INTERNAL_API_URL — cluster-internal).
// Client Components call clientApi (uses NEXT_PUBLIC_API_URL — browser-facing).

import axios from "axios";
import { cookies } from "next/headers";

// ─── Server-side client (used in Server Components / Server Actions) ─────────

export async function serverApi<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const base =
    process.env.INTERNAL_API_URL?.replace(/\/$/, "") ??
    "http://localhost:8080";

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value ?? "";

  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Cookie: `token=${token}` } : {}),
      ...(options.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.message ?? res.statusText, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ─── Client-side axios instance (used in Client Components) ──────────────────

export const clientApi = axios.create({
  baseURL:
    typeof window !== "undefined"
      ? (process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "")
      : "",
  withCredentials: true, // forward httpOnly cookie on same-origin requests
});

// ─── Shared error type ────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly body?: any
  ) {
    super(message);
    this.name = "ApiError";
  }
}
