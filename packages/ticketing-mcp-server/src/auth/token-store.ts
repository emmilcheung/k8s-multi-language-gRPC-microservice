import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'ticketing-mcp');
const TOKEN_FILE = join(CONFIG_DIR, 'tokens.json');

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresAt: number; // unix timestamp (ms)
}

export function readTokens(): StoredTokens | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const raw = readFileSync(TOKEN_FILE, 'utf-8');
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export function writeTokens(tokens: StoredTokens): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function clearTokens(): void {
  if (existsSync(TOKEN_FILE)) {
    unlinkSync(TOKEN_FILE);
  }
}

export function isExpired(tokens: StoredTokens, skewMs = 30_000): boolean {
  return Date.now() + skewMs >= tokens.expiresAt;
}
