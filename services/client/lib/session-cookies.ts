import { parse, splitCookiesString } from "set-cookie-parser";

type SameSite = "lax" | "strict" | "none";

export interface ParsedCookieValue {
  value?: string;
  path?: string;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string | boolean;
}

export const ACCESS_TOKEN_COOKIE =
  process.env.JWT_COOKIE_NAME?.trim() || "token";

export const REFRESH_TOKEN_COOKIE =
  process.env.REFRESH_COOKIE_NAME?.trim() || "refreshToken";

// Non-httpOnly UI hint cookie. Lets the client NavBar render logged-in state
// synchronously (no server round-trip), so the root layout never reads cookies()
// (which would force every route dynamic and bake per-user nav into cacheable
// HTML). NOT security-bearing — the httpOnly access token is the auth source of
// truth; this only drives nav presentation.
export const LOGGED_IN_HINT_COOKIE = "logged_in";

const DEFAULT_REFRESH_SKEW_SECONDS = 30;

export const REFRESH_SKEW_SECONDS = (() => {
  const parsed = Number(process.env.SESSION_REFRESH_SKEW_SECONDS ?? "");
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_REFRESH_SKEW_SECONDS;
})();

export const ACCESS_COOKIE_PATH =
  process.env.ACCESS_TOKEN_COOKIE_PATH?.trim() || "/";

export const REFRESH_COOKIE_PATH =
  process.env.REFRESH_COOKIE_PATH?.trim() || "/";

function normalizeSameSite(value: string | boolean | undefined): SameSite | undefined {
  if (typeof value === "boolean") {
    return value ? "strict" : undefined;
  }

  const normalized = value?.toLowerCase();
  if (normalized === "lax" || normalized === "strict" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

export const ACCESS_COOKIE_SAME_SITE =
  normalizeSameSite(process.env.ACCESS_TOKEN_COOKIE_SAME_SITE) ?? "strict";

export const REFRESH_COOKIE_SAME_SITE =
  normalizeSameSite(process.env.REFRESH_TOKEN_COOKIE_SAME_SITE) ?? "strict";

export function parseAuthCookies(
  rawSetCookie: string | string[] | null
): Record<string, ParsedCookieValue> {
  if (!rawSetCookie) return {};

  const normalized = Array.isArray(rawSetCookie)
    ? rawSetCookie
    : splitCookiesString(rawSetCookie);

  return parse(normalized, { map: true }) as Record<string, ParsedCookieValue>;
}

export interface CookieOptionDefaults {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
  path?: string;
  maxAge?: number;
}

export function toCookieOptions(
  cookie: ParsedCookieValue,
  defaults: CookieOptionDefaults = {}
): {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
  path?: string;
  maxAge?: number;
} {
  const parsedMaxAge = Number(cookie.maxAge);

  return {
    httpOnly: cookie.httpOnly ?? defaults.httpOnly,
    secure: cookie.secure ?? defaults.secure,
    sameSite: normalizeSameSite(cookie.sameSite) ?? defaults.sameSite,
    path: cookie.path ?? defaults.path,
    ...(Number.isFinite(parsedMaxAge)
      ? { maxAge: parsedMaxAge }
      : Number.isFinite(defaults.maxAge)
        ? { maxAge: Number(defaults.maxAge) }
        : {}),
  };
}
