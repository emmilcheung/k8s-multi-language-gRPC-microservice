// The organizer account the signed-in user is acting as, remembered per
// browser in a cookie so Server Components and Server Actions can read it.
//
// The services treat it as a selector only: every check verifies the user's
// membership, so a forged value grants nothing. We still send only uuids.

import { cookies } from "next/headers";

export const ORGANIZER_ACCOUNT_COOKIE = "organizer_account";
export const ORGANIZER_ACCOUNT_HEADER = "X-Organizer-Account";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** The stored account if the user still belongs to it, else their first account. */
export function resolveSelectedAccountId(
  accountIds: string[],
  stored: string | undefined,
): string | undefined {
  if (stored && accountIds.includes(stored)) return stored;
  return accountIds[0];
}

/** The account id stored in the cookie, or undefined when absent, malformed or outside a request. */
export async function readSelectedAccountId(): Promise<string | undefined> {
  try {
    const value = (await cookies()).get(ORGANIZER_ACCOUNT_COOKIE)?.value;
    return isAccountId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Headers that tell organizer endpoints which account the caller is acting as. */
export async function organizerAccountHeaders(): Promise<Record<string, string>> {
  const accountId = await readSelectedAccountId();
  return accountId ? { [ORGANIZER_ACCOUNT_HEADER]: accountId } : {};
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Remembers the acting account for this browser. */
export async function rememberAccount(accountId: string): Promise<void> {
  (await cookies()).set(ORGANIZER_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}
