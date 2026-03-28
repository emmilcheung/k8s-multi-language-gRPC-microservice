// lib/api.ts
// Server-side and client-side API helpers.
// Server Components call serverApi (uses INTERNAL_API_URL — cluster-internal).
// Client Components call clientApi (uses NEXT_PUBLIC_API_URL — browser-facing).

import axios from "axios";
import { cookies } from "next/headers";

// Paths whose responses are safe to cache via ISR (non-user-specific, read-only).
// All other paths use cache:"no-store" to prevent stale user-specific data.
const CACHEABLE_PATHS = ["/api/tickets"];

// Default ISR revalidation window in seconds for cacheable paths.
const ISR_REVALIDATE_SECONDS = 10;

function isCacheable(path: string): boolean {
  return CACHEABLE_PATHS.some((p) => path === p || path.startsWith(p + "?"));
}

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

  // Use ISR for public ticket listings so the CDN / Next.js cache can serve
  // them without hitting the upstream on every request (P-03). All user-specific
  // or mutation paths bypass the cache entirely.
  const nextCacheOptions: RequestInit = token
    ? { cache: "no-store" }
    : isCacheable(path)
      ? { next: { revalidate: ISR_REVALIDATE_SECONDS } }
      : { cache: "no-store" };

  const res = await fetch(`${base}${path}`, {
    ...nextCacheOptions,
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Cookie: `token=${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.message ?? res.statusText, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

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
