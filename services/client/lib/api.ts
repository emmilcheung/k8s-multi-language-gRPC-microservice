// lib/api.ts
// Server-side API helpers for Server Components and Server Actions.
// Use lib/server-utils.ts for base() / authHeaders() in Server Actions.
// Client Components should use plain fetch() with relative URLs.

import { cookies } from "next/headers";
import { traceHeaders } from "@/lib/tracing";
import type {
  AdmissionPass,
  AttendanceCheckInList,
  AttendanceSettings,
  AttendanceSummary,
  ScannerRequest,
  ScannerResponse,
  UserLookupResponse,
} from "@/lib/types";

// Paths whose responses are safe to cache via ISR (non-user-specific, read-only).
// All other paths use cache:"no-store" to prevent stale user-specific data.
const CACHEABLE_PATHS = ["/api/tickets"];

// Default ISR revalidation window in seconds for cacheable paths.
const ISR_REVALIDATE_SECONDS = 10;
const READ_RETRY_DELAYS_MS = [250, 500, 750, 1000, 1250, 1500];

function isCacheable(path: string): boolean {
  return CACHEABLE_PATHS.some((p) => path === p || path.startsWith(p + "?"));
}

function isRetryableReadMethod(method?: string): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return null;

  return Math.max(0, dateMs - Date.now());
}

// ─── Server-side client (used in Server Components / Server Actions) ─────────

export async function serverApi<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const base =
    (
      process.env.INTERNAL_API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:8080"
    ).replace(/\/$/, "");

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

  const canRetry = isRetryableReadMethod(options.method);

  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
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
        const shouldRetry =
          canRetry &&
          attempt < READ_RETRY_DELAYS_MS.length &&
          (res.status === 429 || res.status >= 500);
        if (shouldRetry) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfterMs ?? READ_RETRY_DELAYS_MS[attempt])
          );
          continue;
        }

        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body?.error?.message ?? res.statusText, body);
      }

      if (res.status === 204) return undefined as T;
      return res.json();
    } catch (error) {
      if (!canRetry || attempt === READ_RETRY_DELAYS_MS.length || error instanceof ApiError) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]));
    }
  }

  throw new Error(`Failed to fetch ${path}.`);
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

export async function getAttendanceSettings(eventId: string): Promise<AttendanceSettings> {
  return serverApi<AttendanceSettings>(`/api/attendance/events/${eventId}/settings`);
}

export async function getAttendanceSummary(eventId: string): Promise<AttendanceSummary> {
  return serverApi<AttendanceSummary>(`/api/attendance/events/${eventId}/summary`);
}

export async function getAttendanceCheckIns(eventId: string): Promise<AttendanceCheckInList> {
  return serverApi<AttendanceCheckInList>(`/api/attendance/events/${eventId}/checkins`);
}

export async function lookupUser(input: { email?: string; id?: string }): Promise<UserLookupResponse> {
  const query = new URLSearchParams();
  if (input.email) query.set("email", input.email);
  if (input.id) query.set("id", input.id);
  return serverApi<UserLookupResponse>(`/api/users/lookup?${query.toString()}`);
}

export async function getAdmissionPass(ticketId: string, orderId?: string): Promise<AdmissionPass> {
  const qs = orderId ? `?orderId=${encodeURIComponent(orderId)}` : "";
  return serverApi<AdmissionPass>(`/api/attendance/tickets/${ticketId}${qs}`);
}

export async function scanValidate(input: ScannerRequest): Promise<ScannerResponse> {
  return serverApi<ScannerResponse>("/api/attendance/scan/validate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function scanCheckIn(input: ScannerRequest): Promise<ScannerResponse> {
  return serverApi<ScannerResponse>("/api/attendance/scan/check-in", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
