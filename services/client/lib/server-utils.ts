/**
 * Shared server-side utilities for Next.js Server Actions.
 *
 * These helpers are imported by app/actions/*.ts.  They must NOT be marked
 * "use server" — they are plain utility functions, not Server Actions.
 */

import { cookies } from "next/headers";
import { traceHeaders } from "@/lib/tracing";

/**
 * Returns the base URL for the internal API gateway.
 * Uses INTERNAL_API_URL (cluster-internal Kong URL) in production/staging and
 * falls back to localhost for local docker-compose development.
 */
export const base = (): string =>
  (process.env.INTERNAL_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

interface RequestWithCookies {
  cookies: {
    get(name: string): { value: string } | undefined;
  };
}

/**
 * Returns fetch headers that forward the auth token cookie to the upstream API.
 * Reads the "token" cookie from the current request context.
 * Optionally accepts a NextRequest to extract headers from (for use in Route Handlers).
 */
export async function authHeaders(request?: RequestWithCookies): Promise<HeadersInit> {
  let token: string | undefined;

  if (request && typeof request.cookies?.get === "function") {
    // Extract from NextRequest (Route Handler context)
    token = request.cookies.get("token")?.value;
  } else {
    // Extract from global cookies context (Server Action context)
    const cookieStore = await cookies();
    token = cookieStore.get("token")?.value;
  }

  return {
    "Content-Type": "application/json",
    ...traceHeaders(),
    ...(token ? { Cookie: `token=${token}` } : {}),
  };
}
