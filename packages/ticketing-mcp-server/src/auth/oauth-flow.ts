import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeTokens, type StoredTokens } from './token-store.js';

// ── Callback page HTML ─────────────────────────────────────────────────────────

const PAGE_STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#111;border:1px solid #222;border-radius:12px;padding:40px;max-width:420px;width:100%;text-align:center}
  .icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
  h1{font-size:20px;font-weight:700;margin-bottom:8px}
  p{font-size:14px;color:#888;line-height:1.6}
  .detail{margin-top:20px;padding:12px 16px;background:#0a0a0a;border:1px solid #222;border-radius:8px;font-size:12px;font-family:monospace;word-break:break-all;color:#555}
`.replace(/\n\s*/g, '');

function successPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authenticated — Ticketing MCP</title><style>${PAGE_STYLE}.icon{background:#052e16}</style></head><body><div class="card"><div class="icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><h1>Authenticated</h1><p>You are signed in to the Ticketing MCP server.<br>You may close this tab and return to your agent.</p></div></body></html>`;
}

function errorPage(message: string): string {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authentication Failed — Ticketing MCP</title><style>${PAGE_STYLE}.icon{background:#1c0606}.detail{border-color:#3a1010;color:#f87171}</style></head><body><div class="card"><div class="icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div><h1>Authentication Failed</h1><p>Something went wrong. Close this tab and try again from your agent.</p><div class="detail">${safe}</div></div></body></html>`;
}

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
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorPage(`OAuth error: ${error}`));
        server.close(() => reject(new Error(`OAuth error: ${error}`)));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorPage('Invalid callback: state mismatch or missing code.'));
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
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(errorPage(`Token exchange failed — check the terminal for details.`));
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

        console.error('[ticketing-mcp] Authentication successful. Tokens stored.\n');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successPage());
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
      const authUrlString = authUrl.toString();
      await open(authUrlString);
      console.error(
        '\n[ticketing-mcp] Opening browser for authentication...\n' +
        `  URL: ${authUrlString}\n\n` +
        '  If the browser did not open, copy the URL above and paste it into your browser.\n' +
        '  Waiting for you to sign in (timeout: 5 minutes)...\n',
      );
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
