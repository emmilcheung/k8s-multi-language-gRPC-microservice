import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpException, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import type { Request } from 'express';
import supertest from 'supertest';
import { AuthService } from '../auth/auth.service';
import { buildJwtOptions } from '../auth/auth.module';
import { UserIdSignatureValidator } from '../../common/security/user-id-signature.validator';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

// RFC 8693 token exchange. Throwaway key and secret: generated per run,
// never a real credential.
const MCP = 'https://ticketing.example.com/mcp';
const API = 'https://ticketing.example.com/api';
const ISSUER = 'https://ticketing.example.com';
const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const MCP_CLIENT = 'mcp-service';

const { privateKey: RSA_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SECRET = randomBytes(24).toString('hex');
const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');
const SECRET_HASH = sha256Hex(SECRET);

interface Opts {
  flag?: boolean;
  hash?: string | null; // null = env unset
  blacklisted?: boolean; // every jti is on the revocation blacklist
}

function build(opts: Opts = {}) {
  const env: Record<string, unknown> = {
    RSA_PRIVATE_KEY: RSA_PEM,
    OAUTH_ISSUER: ISSUER,
    OAUTH_RESOURCES: `${MCP},${API}`,
    OAUTH_MCP_RESOURCE: MCP,
    OAUTH_API_AUDIENCE: API,
    OAUTH_ISSUER_ENABLED: String(opts.flag ?? false),
    JWT_EXPIRY: '15m',
  };
  if (opts.hash !== null) {
    env.MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH = opts.hash ?? SECRET_HASH;
  }
  const config = {
    get: (k: string, fb?: unknown) => env[k] ?? fb,
    getOrThrow: (k: string) => env[k],
  };
  const jwt = new JwtService(buildJwtOptions(config as never));
  const authLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const authService = new AuthService(
    authLogger as never,
    { findById: vi.fn() } as never,
    jwt,
    config as never,
    {} as never,
    {} as never,
    {
      get: vi.fn().mockResolvedValue(opts.blacklisted ? '1' : null),
    } as never,
  );
  const refreshTokenService = {
    issue: vi.fn(),
    rotate: vi.fn().mockRejectedValue(new Error('invalid')),
    extractSessionId: vi.fn().mockReturnValue(null),
  };
  const usersRepo = {
    findById: vi.fn().mockResolvedValue({ id: 'user-1', email: 'u@x.test' }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new OAuthService(
    authService,
    refreshTokenService as never,
    usersRepo as never,
    {} as never,
    config as never,
    {
      findClient: vi.fn().mockResolvedValue({
        clientId: 'dyn-uuid',
        clientName: 'Dyn',
        redirectUris: ['http://127.0.0.1:5000/cb'],
        grantTypes: ['authorization_code'],
        allowedScopes: ['tickets:read'],
        pkceRequired: true,
        accessTokenLifetimeSeconds: 900,
        refreshTokenLifetimeSeconds: 3600,
        isFirstParty: false,
        registeredAt: '2026-10-01T00:00:00.000Z',
      }),
    } as never,
    {} as never,
    logger as never,
    {
      resolve: vi.fn().mockResolvedValue({ ok: false, reason: 'disabled' }),
      peek: vi.fn().mockResolvedValue(null),
    } as never,
  );
  const subjectIss = opts.flag ? ISSUER : 'auth-service';
  /** A token as the MCP-audience /oauth/token branch mints it. */
  const mcpToken = (
    over: {
      aud?: string;
      iss?: string;
      scope?: string;
      clientId?: string;
    } = {},
  ) =>
    authService.issueAccessTokenForOAuth(
      'user-1',
      over.scope ?? 'tickets:read orders:create',
      over.clientId ?? 'dyn-uuid',
      { aud: over.aud ?? MCP, iss: over.iss ?? subjectIss },
    );
  return {
    service,
    authService,
    jwt,
    mcpToken,
    refreshTokenService,
    usersRepo,
    logger,
  };
}

const req = { headers: {}, ip: '203.0.113.9' } as unknown as Request;
const BASIC_OK = { clientId: MCP_CLIENT, clientSecret: SECRET };

const body = (subject: string, extra: Record<string, unknown> = {}) =>
  ({
    grant_type: GRANT,
    subject_token: subject,
    subject_token_type: ACCESS_TOKEN_TYPE,
    resource: API,
    ...extra,
  }) as never;

const errOf = async (p: Promise<unknown>) => {
  const e = (await p.catch((x: unknown) => x)) as HttpException;
  expect(e).toBeInstanceOf(HttpException);
  return { status: e.getStatus(), body: e.getResponse() };
};

const decode = (jwt: JwtService, token: string) =>
  jwt.decode<Record<string, unknown>>(token);

describe('only the mcp-service client may exchange', () => {
  it('a public static client is unauthorized_client and nothing is minted', async () => {
    const t = build();
    const subject = t.mcpToken();
    const spy = vi.spyOn(t.authService, 'issueAccessTokenForOAuth');
    const err = await errOf(
      t.service.token(body(subject, { client_id: 'ticketing-mcp' }), req),
    );
    expect(err.body).toMatchObject({ error: 'unauthorized_client' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a dynamic client cannot exchange even with a Basic secret that is correct for mcp-service', async () => {
    const t = build();
    const err = await errOf(
      t.service.token(body(t.mcpToken()), req, {
        clientId: 'dyn-uuid',
        clientSecret: SECRET,
      }),
    );
    expect(err.body).toMatchObject({ error: 'unauthorized_client' });
  });

  it('an unknown client id is invalid_client', async () => {
    const t = build();
    (
      t.service as unknown as {
        dynamicClientService: { findClient: ReturnType<typeof vi.fn> };
      }
    ).dynamicClientService.findClient.mockResolvedValue(null);
    const err = await errOf(
      t.service.token(body(t.mcpToken()), req, {
        clientId: 'nobody',
        clientSecret: SECRET,
      }),
    );
    expect(err.body).toMatchObject({ error: 'invalid_client' });
  });
});

describe('the subject must be an MCP-audience token this server issued', () => {
  it('a subject with the API aud is invalid_grant (an exchanged token cannot be re-exchanged)', async () => {
    const t = build();
    const err = await errOf(
      t.service.token(body(t.mcpToken({ aud: API })), req, BASIC_OK),
    );
    expect(err.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('a browser token (no aud, no client_id) is invalid_grant', async () => {
    const t = build();
    const browser = t.jwt.sign({ sub: 'user-1', jti: 'j', email: 'u@x.test' });
    const err = await errOf(t.service.token(body(browser), req, BASIC_OK));
    expect(err.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('a token signed by another key is invalid_grant', async () => {
    const t = build();
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const forged = new JwtService({ privateKey: other }).sign(
      { sub: 'user-1', jti: 'j', scope: 'tickets:read', client_id: 'dyn-uuid' },
      { algorithm: 'RS256', audience: MCP, issuer: 'auth-service' },
    );
    const err = await errOf(t.service.token(body(forged), req, BASIC_OK));
    expect(err.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('an expired subject is invalid_grant', async () => {
    const t = build();
    const expired = t.jwt.sign(
      { sub: 'user-1', jti: 'j', scope: 'tickets:read', client_id: 'dyn-uuid' },
      { audience: MCP, issuer: 'auth-service', expiresIn: -10 },
    );
    const err = await errOf(t.service.token(body(expired), req, BASIC_OK));
    expect(err.body).toMatchObject({ error: 'invalid_grant' });
  });

  it.each([
    [false, 'auth-service'],
    [false, ISSUER],
    [true, 'auth-service'],
    [true, ISSUER],
  ])(
    'flag=%s, subject iss=%s -> exchanged (a token minted just before a flag flip must still work)',
    async (flag, subjectIss) => {
      const t = build({ flag });
      const res = await t.service.token(
        body(t.mcpToken({ iss: subjectIss })),
        req,
        BASIC_OK,
      );
      // The exchanged iss still follows the flag, whatever the subject carried.
      expect(decode(t.jwt, res.access_token).iss).toBe(
        flag ? ISSUER : 'auth-service',
      );
    },
  );

  it.each([false, true])(
    'flag=%s: a third issuer is invalid_grant',
    async (flag) => {
      const t = build({ flag });
      const err = await errOf(
        t.service.token(
          body(t.mcpToken({ iss: 'https://evil.example.com' })),
          req,
          BASIC_OK,
        ),
      );
      expect(err.body).toMatchObject({ error: 'invalid_grant' });
    },
  );

  it('a subject whose jti was revoked (signout/blacklist) is invalid_grant', async () => {
    const t = build({ blacklisted: true });
    const err = await errOf(t.service.token(body(t.mcpToken()), req, BASIC_OK));
    expect(err.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('a wrong subject_token_type is invalid_request', async () => {
    const t = build();
    const err = await errOf(
      t.service.token(
        body(t.mcpToken(), {
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        }),
        req,
        BASIC_OK,
      ),
    );
    expect(err.body).toMatchObject({ error: 'invalid_request' });
  });
});

describe('the only exchange target is OAUTH_API_AUDIENCE', () => {
  it.each([
    ['another origin', 'https://evil.example/api'],
    ['the MCP resource itself', MCP],
  ])('%s is invalid_target', async (_n, resource) => {
    const t = build();
    const err = await errOf(
      t.service.token(body(t.mcpToken(), { resource }), req, BASIC_OK),
    );
    expect(err.body).toMatchObject({ error: 'invalid_target' });
  });

  it('audience (RFC 8693) is accepted as the target, and a conflict with resource is invalid_target', async () => {
    const t = build();
    await expect(
      t.service.token(
        body(t.mcpToken(), { resource: undefined, audience: API }),
        req,
        BASIC_OK,
      ),
    ).resolves.toMatchObject({ token_type: 'Bearer' });
    const err = await errOf(
      t.service.token(body(t.mcpToken(), { audience: MCP }), req, BASIC_OK),
    );
    expect(err.body).toMatchObject({ error: 'invalid_target' });
  });

  it('no target defaults to OAUTH_API_AUDIENCE', async () => {
    const t = build();
    const res = await t.service.token(
      body(t.mcpToken(), { resource: undefined }),
      req,
      BASIC_OK,
    );
    expect(decode(t.jwt, res.access_token).aud).toBe(API);
  });
});

describe('scope can only narrow', () => {
  it('a requested scope outside the subject scope is invalid_scope', async () => {
    const t = build();
    const err = await errOf(
      t.service.token(
        body(t.mcpToken({ scope: 'tickets:read' }), {
          scope: 'tickets:read orders:create',
        }),
        req,
        BASIC_OK,
      ),
    );
    expect(err.body).toMatchObject({ error: 'invalid_scope' });
  });

  it('a subset is granted exactly, and no scope means the full subject scope', async () => {
    const t = build();
    const subset = await t.service.token(
      body(t.mcpToken(), { scope: 'orders:create' }),
      req,
      BASIC_OK,
    );
    expect(subset.scope).toBe('orders:create');
    expect(decode(t.jwt, subset.access_token).scope).toBe('orders:create');
    const full = await t.service.token(body(t.mcpToken()), req, BASIC_OK);
    expect(full.scope).toBe('tickets:read orders:create');
  });
});

describe('the exchanged token equals the exchanged-token shape', () => {
  it.each([
    [false, 'auth-service'],
    [true, ISSUER],
  ])(
    'flag=%s: iss follows the issuer flag, aud is the API, client_id is the ORIGINAL client, act names mcp-service, no email/roles, no refresh token',
    async (flag, iss) => {
      const t = build({ flag });
      const res = await t.service.token(
        body(t.mcpToken(), { scope: 'orders:create' }),
        req,
        BASIC_OK,
      );
      expect(Object.keys(res).sort()).toEqual(
        [
          'access_token',
          'expires_in',
          'issued_token_type',
          'scope',
          'token_type',
        ].sort(),
      );
      expect(res).toMatchObject({
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'orders:create',
      });
      const claims = decode(t.jwt, res.access_token);
      expect(claims).toMatchObject({
        iss,
        sub: 'user-1',
        aud: API,
        client_id: 'dyn-uuid',
        scope: 'orders:create',
        act: { sub: MCP_CLIENT },
      });
      expect(claims.jti).toEqual(expect.any(String));
      expect(claims).not.toHaveProperty('email');
      expect(claims).not.toHaveProperty('roles');
      expect(
        (claims.exp as number) - (claims.iat as number),
      ).toBeLessThanOrEqual(300);
      expect(t.refreshTokenService.issue).not.toHaveBeenCalled();
    },
  );

  it('exp never outlives the subject (a 60 s subject yields <= 60 s)', async () => {
    const t = build();
    const short = t.jwt.sign(
      { sub: 'user-1', jti: 'j', scope: 'tickets:read', client_id: 'dyn-uuid' },
      { audience: MCP, issuer: 'auth-service', expiresIn: 60 },
    );
    const res = await t.service.token(body(short), req, BASIC_OK);
    const subjectExp = decode(t.jwt, short).exp as number;
    expect(decode(t.jwt, res.access_token).exp as number).toBeLessThanOrEqual(
      subjectExp,
    );
    expect(res.expires_in).toBeLessThanOrEqual(60);
  });

  it('the 300 s cap applies when the subject lives longer (900 s)', async () => {
    const t = build();
    const res = await t.service.token(body(t.mcpToken()), req, BASIC_OK);
    expect(res.expires_in).toBe(300);
  });

  describe('exp is absolute, min(now+300, subject.exp), computed once', () => {
    afterEach(() => vi.useRealTimers());

    it('a subject with 1 s left yields exp === subject exp and a matching expires_in', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
      const t = build();
      const subject = t.jwt.sign(
        {
          sub: 'user-1',
          jti: 'j',
          scope: 'tickets:read',
          client_id: 'dyn-uuid',
        },
        { audience: MCP, issuer: 'auth-service', expiresIn: 1 },
      );
      const subjectExp = decode(t.jwt, subject).exp as number;
      const res = await t.service.token(body(subject), req, BASIC_OK);
      const claims = decode(t.jwt, res.access_token);
      expect(claims.exp).toBe(subjectExp);
      expect(res.expires_in).toBe(1);
    });

    it('a clock tick between the expiry check and minting never yields a zero lifetime (no 500)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
      const t = build();
      const subject = t.jwt.sign(
        {
          sub: 'user-1',
          jti: 'j',
          scope: 'tickets:read',
          client_id: 'dyn-uuid',
        },
        { audience: MCP, issuer: 'auth-service', expiresIn: 1 },
      );
      const subjectExp = decode(t.jwt, subject).exp as number;
      // The second ticks over while the user lookup is in flight.
      t.usersRepo.findById.mockImplementation(() => {
        vi.setSystemTime(new Date('2026-10-02T00:00:01.000Z'));
        return Promise.resolve({ id: 'user-1', email: 'u@x.test' });
      });
      const res = await t.service.token(body(subject), req, BASIC_OK);
      expect(res.expires_in).toBeGreaterThan(0);
      expect(decode(t.jwt, res.access_token).exp).toBe(subjectExp);
    });

    it('a long-lived subject yields exp === iat + 300', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
      const t = build();
      const res = await t.service.token(body(t.mcpToken()), req, BASIC_OK);
      const claims = decode(t.jwt, res.access_token);
      expect(claims.exp).toBe((claims.iat as number) + 300);
    });
  });

  it('a subject whose user no longer exists is invalid_grant', async () => {
    const t = build();
    t.usersRepo.findById.mockResolvedValue(null);
    const err = await errOf(t.service.token(body(t.mcpToken()), req, BASIC_OK));
    expect(err.body).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('client authentication (confidential client, constant-time compare)', () => {
  it('a wrong secret is a 401 invalid_client and nothing is minted', async () => {
    const t = build();
    const err = await errOf(
      t.service.token(body(t.mcpToken()), req, {
        clientId: MCP_CLIENT,
        clientSecret: 'not-the-secret',
      }),
    );
    expect(err.status).toBe(401);
    expect(err.body).toMatchObject({ error: 'invalid_client' });
  });

  it('with no Basic credentials the confidential client is a 401 invalid_client', async () => {
    const t = build();
    const err = await errOf(
      t.service.token(body(t.mcpToken(), { client_id: MCP_CLIENT }), req),
    );
    expect(err.status).toBe(401);
    expect(err.body).toMatchObject({ error: 'invalid_client' });
  });

  it('with the hash env unset the grant is disabled: even the right secret is 401, and the service still constructs', async () => {
    const t = build({ hash: null });
    const err = await errOf(t.service.token(body(t.mcpToken()), req, BASIC_OK));
    expect(err.status).toBe(401);
    expect(err.body).toMatchObject({ error: 'invalid_client' });
  });

  it('a body client_id that disagrees with the Basic client id is invalid_request', async () => {
    const t = build();
    const err = await errOf(
      t.service.token(
        body(t.mcpToken(), { client_id: 'someone-else' }),
        req,
        BASIC_OK,
      ),
    );
    expect(err.body).toMatchObject({ error: 'invalid_request' });
  });
});

describe('over HTTP a failed client_secret_basic is 401 + WWW-Authenticate', () => {
  async function app(opts: Opts = {}) {
    const t = build(opts);
    const mod = await Test.createTestingModule({
      controllers: [OAuthController],
      providers: [
        { provide: OAuthService, useValue: t.service },
        { provide: UserIdSignatureValidator, useValue: {} },
        { provide: Logger, useValue: { error: vi.fn() } },
      ],
    }).compile();
    const nest: INestApplication = mod.createNestApplication();
    nest.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await nest.init();
    return { nest, t };
  }
  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
  const form = (t: ReturnType<typeof build>) => ({
    grant_type: GRANT,
    subject_token: t.mcpToken(),
    subject_token_type: ACCESS_TOKEN_TYPE,
    resource: API,
  });

  it('a wrong secret -> 401, WWW-Authenticate: Basic realm="oauth", RFC error body, no-store', async () => {
    const { nest, t } = await app();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', basic(MCP_CLIENT, 'wrong'))
      .type('form')
      .send(form(t));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="oauth"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ error: 'invalid_client' });
    await nest.close();
  });

  it('a malformed Basic header is also 401 + challenge', async () => {
    const { nest, t } = await app();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', 'Basic !!!not-base64!!!')
      .type('form')
      .send(form(t));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="oauth"');
    await nest.close();
  });

  it('the right secret exchanges (200, no WWW-Authenticate) with only Basic credentials and no body client_id', async () => {
    const { nest, t } = await app();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', basic(MCP_CLIENT, SECRET))
      .type('form')
      .send(form(t));
    expect(res.status).toBe(200);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.body).toMatchObject({
      token_type: 'Bearer',
      issued_token_type: ACCESS_TOKEN_TYPE,
    });
    expect(res.body).not.toHaveProperty('refresh_token');
    await nest.close();
  });

  it('a non-Basic failure keeps its status: invalid_grant stays 400 with no challenge', async () => {
    const { nest, t } = await app();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', basic(MCP_CLIENT, SECRET))
      .type('form')
      .send({ ...form(t), subject_token: 'garbage' });
    expect(res.status).toBe(400);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    await nest.close();
  });

  it('the existing grants still require client_id in the body (invalid_request)', async () => {
    const { nest } = await app();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: 'a.b' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_request' });
    await nest.close();
  });
});

describe('Basic parsing and per-grant scope', () => {
  async function appFor(opts: Opts = {}) {
    const t = build(opts);
    const mod = await Test.createTestingModule({
      controllers: [OAuthController],
      providers: [
        { provide: OAuthService, useValue: t.service },
        { provide: UserIdSignatureValidator, useValue: {} },
        { provide: Logger, useValue: { error: vi.fn() } },
      ],
    }).compile();
    const nest: INestApplication = mod.createNestApplication();
    nest.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await nest.init();
    return { nest, t };
  }
  const rawBasic = (userpass: string) =>
    `Basic ${Buffer.from(userpass).toString('base64')}`;
  const exchangeForm = (t: ReturnType<typeof build>) => ({
    grant_type: GRANT,
    subject_token: t.mcpToken(),
    subject_token_type: ACCESS_TOKEN_TYPE,
    resource: API,
  });

  it('`+` in Basic credentials decodes to a space (RFC 6749 2.3.1 form-urlencoding)', async () => {
    const { nest, t } = await appFor({ hash: sha256Hex('sec ret') });
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', rawBasic(`${MCP_CLIENT}:sec+ret`))
      .type('form')
      .send(exchangeForm(t));
    expect(res.status).toBe(200);
    await nest.close();
  });

  it('a client secret containing `:` authenticates (Basic splits on the FIRST colon only)', async () => {
    const { nest, t } = await appFor({ hash: sha256Hex('ab:cd') });
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', rawBasic(`${MCP_CLIENT}:ab:cd`))
      .type('form')
      .send(exchangeForm(t));
    expect(res.status).toBe(200);
    await nest.close();
  });

  it('a malformed percent-escape in Basic credentials is 401 invalid_client with the challenge', async () => {
    const { nest, t } = await appFor();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', rawBasic(`${MCP_CLIENT}:%zz`))
      .type('form')
      .send(exchangeForm(t));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="oauth"');
    await nest.close();
  });

  it('a malformed Basic header on a refresh request is ignored exactly as before (400 invalid_grant, no challenge)', async () => {
    const { nest } = await appFor();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .set('Authorization', 'Basic !!!not-base64!!!')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: 'a.b',
        client_id: 'dyn-uuid',
      });
    expect(res.status).toBe(400);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    await nest.close();
  });

  it.each([
    [
      'authorization_code',
      { code: 'c', code_verifier: 'v', redirect_uri: 'http://127.0.0.1:1/cb' },
    ],
    ['refresh_token', { refresh_token: 'a.b' }],
  ])('%s without client_id is 400 invalid_request', async (grant, extra) => {
    const { nest } = await appFor();
    const res = await supertest(nest.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: grant, ...extra });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_request' });
    await nest.close();
  });
});

describe('logs never carry token material', () => {
  const dump = (t: ReturnType<typeof build>) =>
    JSON.stringify([
      t.logger.info.mock.calls,
      t.logger.warn.mock.calls,
      t.logger.error.mock.calls,
    ]);

  it('a successful exchange logs oauth.token.exchanged with client ids and scope, and neither the subject token, the issued token nor the secret', async () => {
    const t = build();
    const subject = t.mcpToken();
    const res = await t.service.token(
      body(subject, { scope: 'orders:create' }),
      req,
      BASIC_OK,
    );
    const logs = dump(t);
    expect(logs).toContain('oauth.token.exchanged');
    expect(t.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'oauth.token.exchanged',
        clientId: MCP_CLIENT,
        originalClientId: 'dyn-uuid',
        scope: 'orders:create',
      }),
      expect.any(String),
    );
    expect(logs).not.toContain(subject);
    expect(logs).not.toContain(subject.split('.')[1]);
    expect(logs).not.toContain(res.access_token);
    expect(logs).not.toContain(SECRET);
  });

  it('rejected exchanges log no subject_token value either', async () => {
    const t = build();
    const bad = t.mcpToken({ aud: API });
    await t.service.token(body(bad), req, BASIC_OK).catch(() => undefined);
    await t.service
      .token(body(bad), req, { clientId: MCP_CLIENT, clientSecret: 'nope' })
      .catch(() => undefined);
    const logs = dump(t);
    expect(logs).not.toContain(bad);
    expect(logs).not.toContain(bad.split('.')[1]);
    expect(logs).not.toContain('nope');
  });
});
