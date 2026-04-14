import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const DYNAMIC_CLIENT_TTL_SECONDS = 31536000; // 1 year
const DYNAMIC_CLIENT_KEY_PREFIX = 'auth-service:oauth:dynamic-client';

export interface DynamicOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  allowedScopes: string[];
  grantTypes: string[]; // default: ['authorization_code']
  pkceRequired: boolean; // always true for dynamic clients
  accessTokenLifetimeSeconds: number; // default: 900
  refreshTokenLifetimeSeconds: number; // default: 86400
  isFirstParty: false;
  registeredAt: string; // ISO timestamp
}

export interface RegisterClientInput {
  clientName: string;
  redirectUris: string[];
  scope?: string; // space-delimited; defaults to all allowed scopes
  grantTypes?: string[]; // defaults to ['authorization_code']
}

const ALL_ALLOWED_SCOPES = [
  'tickets:read',
  'orders:read',
  'orders:create',
  'orders:cancel',
  'payments:read',
  'payments:create',
  'venues:read',
  'seating:read',
  'seating:hold',
];

@Injectable()
export class DynamicClientService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private clientKey(clientId: string): string {
    return `${DYNAMIC_CLIENT_KEY_PREFIX}:${clientId}`;
  }

  private validateRedirectUris(redirectUris: string[]): void {
    for (const uri of redirectUris) {
      try {
        const parsed = new URL(uri);
        const isLocalhost =
          parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        if (parsed.protocol !== 'https:' && !isLocalhost) {
          throw new BadRequestException({
            error: 'invalid_redirect_uri',
            error_description: `redirect_uri must use HTTPS or be localhost: ${uri}`,
          });
        }
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        throw new BadRequestException({
          error: 'invalid_redirect_uri',
          error_description: `Invalid URI: ${uri}`,
        });
      }
    }
  }

  async register(input: RegisterClientInput): Promise<DynamicOAuthClient> {
    this.validateRedirectUris(input.redirectUris);

    const requestedScopes = input.scope
      ? input.scope.split(' ').filter(Boolean)
      : [...ALL_ALLOWED_SCOPES];

    // Only allow scopes from the known set
    const allowedScopes = requestedScopes.filter((s) =>
      ALL_ALLOWED_SCOPES.includes(s),
    );

    const client: DynamicOAuthClient = {
      clientId: randomUUID(),
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      allowedScopes,
      grantTypes: input.grantTypes ?? ['authorization_code'],
      pkceRequired: true,
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeSeconds: 86400,
      isFirstParty: false,
      registeredAt: new Date().toISOString(),
    };

    await this.redis.set(
      this.clientKey(client.clientId),
      JSON.stringify(client),
      'EX',
      DYNAMIC_CLIENT_TTL_SECONDS,
    );

    return client;
  }

  async findClient(clientId: string): Promise<DynamicOAuthClient | null> {
    const raw = await this.redis.get(this.clientKey(clientId));
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'clientId' in parsed &&
        'clientName' in parsed &&
        'redirectUris' in parsed &&
        'allowedScopes' in parsed &&
        'grantTypes' in parsed &&
        'pkceRequired' in parsed &&
        'accessTokenLifetimeSeconds' in parsed &&
        'refreshTokenLifetimeSeconds' in parsed &&
        'registeredAt' in parsed
      ) {
        return parsed as DynamicOAuthClient;
      }
    } catch {
      return null;
    }
    return null;
  }
}
