import { createHash, randomBytes } from "node:crypto";
import { PASSWORD, uniqueEmail } from "./flows";

export const KONG_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
export const MCP_CLIENT_ID = "ticketing-mcp";
export const MCP_REDIRECT_URI = "http://127.0.0.1:19836/callback";

function cookieValue(res: Response, name: string): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!raw) throw new Error(`response set no ${name} cookie`);
  return raw.split(";")[0].slice(name.length + 1);
}

/** Sign up a fresh user; returns the browser session's access and refresh tokens. */
export async function signupViaApi(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${KONG_URL}/api/users/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("oauth-agent"), password: PASSWORD }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return { accessToken: cookieValue(res, "token"), refreshToken: cookieValue(res, "refreshToken") };
}

export function authorizeUrl(scope: string, codeChallenge: string, resource?: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: MCP_CLIENT_ID,
    redirect_uri: MCP_REDIRECT_URI,
    scope,
    state: "e2e-state",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (resource) q.set("resource", resource);
  return `${KONG_URL}/oauth/authorize?${q.toString()}`;
}

/**
 * Run the real PKCE authorization-code flow as the given browser session:
 * authorize → consent approve → token. Returns the OAuth grant.
 */
export async function obtainOAuthAccessToken(
  sessionAccessToken: string,
  scope = "tickets:read orders:read",
  resource?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorize = await fetch(authorizeUrl(scope, challenge, resource), {
    redirect: "manual",
    headers: { Cookie: `token=${sessionAccessToken}` },
  });
  const consentUrl = new URL(authorize.headers.get("location") ?? "");
  const requestId = consentUrl.searchParams.get("request_id");
  if (authorize.status !== 302 || !requestId) {
    throw new Error(`authorize did not reach consent: ${authorize.status} ${consentUrl.href}`);
  }

  const consent = await fetch(`${KONG_URL}/oauth/consent/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `token=${sessionAccessToken}` },
    body: JSON.stringify({ approve: true }),
  });
  const { redirectUrl } = (await consent.json()) as { redirectUrl: string };
  const code = new URL(redirectUrl).searchParams.get("code");
  if (!code) throw new Error(`consent returned no code: ${redirectUrl}`);

  const token = await fetch(`${KONG_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: MCP_CLIENT_ID,
      redirect_uri: MCP_REDIRECT_URI,
      ...(resource ? { resource } : {}),
    }),
  });
  if (token.status !== 200) throw new Error(`token exchange failed: ${token.status} ${await token.text()}`);
  const body = (await token.json()) as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}
