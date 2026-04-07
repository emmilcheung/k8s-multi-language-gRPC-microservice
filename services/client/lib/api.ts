// lib/api.ts
// Server-side API helpers for Server Components and Server Actions.
// Use lib/server-utils.ts for base() / authHeaders() in Server Actions.
// Client Components should use plain fetch() with relative URLs.

import { cookies } from "next/headers";
import { traceHeaders } from "@/lib/tracing";

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

  const headers =
    options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : (options.headers ?? {});

  const res = await fetch(`${base}${path}`, {
    ...nextCacheOptions,
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...traceHeaders(),
      ...(token ? { Cookie: `token=${token}` } : {}),
      ...headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.message ?? res.statusText, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

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
