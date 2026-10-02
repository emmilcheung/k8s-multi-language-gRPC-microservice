import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  CimdFetchError,
  fetchClientMetadataDocument,
  parseClientIdUrl,
} from './cimd-fetcher';
import type { CimdErrorCode, CimdFetchResult } from './cimd-fetcher';
import { validateClientMetadataDocument } from './cimd-document';
import { isUrlClientId, type OAuthClient } from './oauth-clients.config';
import { readOAuthConfig } from './oauth-config';

export const CIMD_FETCH = Symbol('CIMD_FETCH');
export type CimdFetch = (url: string) => Promise<CimdFetchResult>;

const CACHE_KEY_PREFIX = 'auth-service:oauth:cimd';
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 5 * 60;
const NEGATIVE_TTL_SECONDS = 60;
/** Outbound fetches in flight at once, per process. */
const MAX_CONCURRENT_FETCHES = 8;

export type CimdResolution =
  | { ok: true; client: OAuthClient }
  | { ok: false; reason: CimdErrorCode | 'disabled' };

/**
 * TTL from Cache-Control, clamped to [60 s, 24 h]; 5 min when absent or
 * unreadable. no-store / no-cache / max-age=0 still cache for the floor: an
 * unauthenticated caller must not be able to make auth-service fetch on every
 * request.
 */
export function cimdCacheTtlSeconds(cacheControl: string | undefined): number {
  const header = (cacheControl ?? '').toLowerCase();
  if (/(^|[\s,])(no-store|no-cache)([\s,=]|$)/.test(header)) {
    return MIN_TTL_SECONDS;
  }
  const m = /(?:^|[\s,])max-age=(\d+)(?:[\s,]|$)/.exec(header);
  if (!m) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Number(m[1]), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

export { isUrlClientId };

type CacheRecord =
  | { v: 1; ok: true; client: OAuthClient }
  | { v: 1; ok: false; reason: CimdErrorCode };

@Injectable()
export class CimdClientService {
  private readonly inflight = new Map<string, Promise<CimdResolution>>();
  private active = 0;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    @InjectPinoLogger(CimdClientService.name)
    private readonly logger: PinoLogger,
    @Optional()
    @Inject(CIMD_FETCH)
    private readonly fetchDocument: CimdFetch = (url) =>
      fetchClientMetadataDocument(url),
  ) {}

  get enabled(): boolean {
    return readOAuthConfig(this.config).cimdEnabled;
  }

  private cacheKey(url: string): string {
    return `${CACHE_KEY_PREFIX}:${createHash('sha256').update(url).digest('hex')}`;
  }

  private async readCache(key: string): Promise<CacheRecord | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw) as Partial<CacheRecord> | null;
      if (rec?.v === 1 && (rec.ok === true || rec.ok === false)) {
        return rec as CacheRecord;
      }
    } catch {
      // Fall through: a corrupt entry is a miss, not a trusted client.
    }
    return null;
  }

  private static toResolution(rec: CacheRecord): CimdResolution {
    return rec.ok
      ? { ok: true, client: rec.client }
      : { ok: false, reason: rec.reason };
  }

  /** Cached client only. Never fetches: used by listing, which must not reach out. */
  async peek(clientId: string): Promise<OAuthClient | null> {
    if (!this.enabled) return null;
    try {
      parseClientIdUrl(clientId);
    } catch {
      return null;
    }
    const rec = await this.readCache(this.cacheKey(clientId));
    return rec?.ok ? rec.client : null;
  }

  /**
   * Resolve a URL client id: cache first, then one guarded fetch. The URL shape
   * is checked and the flag is read before Redis or the network is touched.
   * Concurrent callers for one URL share a single fetch.
   */
  async resolve(clientId: string): Promise<CimdResolution> {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    try {
      parseClientIdUrl(clientId);
    } catch (e) {
      return { ok: false, reason: (e as CimdFetchError).code };
    }
    const key = this.cacheKey(clientId);
    const shared = this.inflight.get(key);
    if (shared) return shared;
    const p = this.load(clientId, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async load(clientId: string, key: string): Promise<CimdResolution> {
    const cached = await this.readCache(key);
    if (cached) return CimdClientService.toResolution(cached);

    if (this.active >= MAX_CONCURRENT_FETCHES) {
      // Overload is not a verdict on the document: do not cache it.
      return { ok: false, reason: 'busy' };
    }
    this.active++;
    const host = new URL(clientId).hostname;
    let record: CacheRecord;
    let ttl: number;
    try {
      const fetched = await this.fetchDocument(clientId);
      const client = validateClientMetadataDocument(clientId, fetched.body);
      record = { v: 1, ok: true, client };
      ttl = cimdCacheTtlSeconds(fetched.cacheControl);
      this.logger.debug({ event: 'oauth.cimd.fetched', host }, 'CIMD fetched');
    } catch (e) {
      const reason: CimdErrorCode =
        e instanceof CimdFetchError ? e.code : 'connect_failed';
      // Host and reason code only: never the document body, never the full URL.
      this.logger.warn(
        { event: 'oauth.cimd.fetch_failed', host, reason },
        'CIMD client metadata rejected',
      );
      record = { v: 1, ok: false, reason };
      ttl = NEGATIVE_TTL_SECONDS;
    } finally {
      this.active--;
    }
    await this.redis.set(key, JSON.stringify(record), 'EX', ttl);
    return CimdClientService.toResolution(record);
  }
}
