/**
 * Shared server-side utilities for Next.js Server Actions.
 *
 * These helpers are imported by app/actions/*.ts.  They must NOT be marked
 * "use server" — they are plain utility functions, not Server Actions.
 */

import { cookies } from "next/headers";

/**
 * Returns the base URL for the internal API gateway.
 * Uses INTERNAL_API_URL (cluster-internal Kong URL) in production/staging and
 * falls back to localhost for local docker-compose development.
 */
export const base = (): string =>
  (process.env.INTERNAL_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

/**
 * Returns fetch headers that forward the auth token cookie to the upstream API.
 * Reads the "token" cookie from the current request context.
 */
export async function authHeaders(): Promise<HeadersInit> {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value ?? "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Cookie: `token=${token}` } : {}),
  };
}
