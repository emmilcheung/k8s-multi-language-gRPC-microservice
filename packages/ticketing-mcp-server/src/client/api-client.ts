import { readTokens, isExpired, type StoredTokens } from '../auth/token-store.js';
import { refreshTokens, login } from '../auth/oauth-flow.js';

export class ApiClient {
  private apiBaseUrl: string;
  private tokens: StoredTokens | null = null;

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
  }

  private async getValidTokens(): Promise<StoredTokens> {
    if (!this.tokens) {
      this.tokens = readTokens();
    }

    if (!this.tokens || !this.tokens.accessToken) {
      // Not authenticated — trigger OAuth flow
      console.error('[ticketing-mcp] Not authenticated. Starting login flow...');
      this.tokens = await login(this.apiBaseUrl);
      return this.tokens;
    }

    if (isExpired(this.tokens)) {
      try {
        this.tokens = await refreshTokens(this.apiBaseUrl, this.tokens.refreshToken);
      } catch {
        // Refresh failed — re-authenticate
        console.error('[ticketing-mcp] Token refresh failed. Starting login flow...');
        this.tokens = await login(this.apiBaseUrl);
      }
    }

    return this.tokens;
  }

  async get<T>(path: string): Promise<T> {
    const tokens = await this.getValidTokens();
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const tokens = await this.getValidTokens();
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const tokens = await this.getValidTokens();
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
    // Some DELETE endpoints return 204 No Content
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
