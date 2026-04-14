import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeTokens, type StoredTokens } from './token-store.js';

const CLIENT_ID = 'ticketing-mcp';
const REDIRECT_PORT = 19836;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = 'tickets:read orders:read orders:create orders:cancel payments:read payments:create venues:read seating:read seating:hold';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function login(apiBaseUrl: string): Promise<StoredTokens> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Ignore anything that isn't the OAuth callback (e.g. browser favicon requests)
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication failed: ${error}</h1>`);
        server.close(() => reject(new Error(`OAuth error: ${error}`)));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Invalid callback</h1>');
        server.close(() => reject(new Error('State mismatch or missing code')));
        return;
      }

      try {
        const tokenRes = await fetch(`${apiBaseUrl}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h1>Token exchange failed. Check the terminal.</h1>');
          server.close(() => reject(new Error(`Token exchange failed: ${text}`)));
          return;
        }

        const data = await tokenRes.json() as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
          scope: string;
        };

        const tokens: StoredTokens = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          scope: data.scope,
          expiresAt: Date.now() + data.expires_in * 1000,
        };

        writeTokens(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authenticated! You can close this tab and return to your agent.</h1>');
        server.close(() => resolve(tokens));
      } catch (err) {
        server.close(() => reject(err));
      }
    });

    // Abort if the user never completes the browser flow
    const timeout = setTimeout(() => {
      server.close(() => reject(new Error('Login timed out after 5 minutes')));
    }, LOGIN_TIMEOUT_MS);
    // Don't let the timeout keep the process alive if something else closes first
    timeout.unref();

    server.listen(REDIRECT_PORT, '127.0.0.1', async () => {
      const authUrl = new URL(`${apiBaseUrl}/oauth/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('scope', SCOPES);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      // Dynamically import 'open' so it is loaded at runtime (ESM lazy import)
      const { default: open } = await import('open');
      await open(authUrl.toString());
      console.error('[ticketing-mcp] Browser opened for authentication. Waiting for callback...');
    });

    server.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function refreshTokens(apiBaseUrl: string, refreshToken: string): Promise<StoredTokens> {
  const tokenRes = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token refresh failed: ${await tokenRes.text()}`);
  }

  const data = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  writeTokens(tokens);
  return tokens;
}
