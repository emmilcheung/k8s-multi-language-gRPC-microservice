import { clientNameProblem } from './oauth-client-name.util';
import { BadRequestException, Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { OAUTH_SCOPE_NAMES } from './oauth-scopes';
import { assertValidRedirectUris } from './oauth-redirect.util';
import type { OAuthApplicationType } from './oauth-clients.config';

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
  /** RFC 7591 application_type; records stored before WS-I read as 'web'. */
  applicationType?: OAuthApplicationType;
  registeredAt: string; // ISO timestamp
}

export interface RegisterClientInput {
  clientName: string;
  redirectUris: string[];
  scope?: string; // space-delimited; defaults to all allowed scopes
  grantTypes?: string[]; // defaults to ['authorization_code']
  applicationType?: OAuthApplicationType; // defaults to 'web'
}

@Injectable()
export class DynamicClientService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private clientKey(clientId: string): string {
    return `${DYNAMIC_CLIENT_KEY_PREFIX}:${clientId}`;
  }

  async register(input: RegisterClientInput): Promise<DynamicOAuthClient> {
    assertValidRedirectUris(input.redirectUris);
    const nameProblem = clientNameProblem(input.clientName);
    if (nameProblem) {
      throw new BadRequestException({
        error: 'invalid_client_metadata',
        error_description: nameProblem,
      });
    }

    const requestedScopes = input.scope
      ? input.scope.split(' ').filter(Boolean)
      : [...OAUTH_SCOPE_NAMES];

    // Only allow scopes from the known set
    const allowedScopes = requestedScopes.filter((s) =>
      (OAUTH_SCOPE_NAMES as readonly string[]).includes(s),
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
      applicationType: input.applicationType ?? 'web',
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
