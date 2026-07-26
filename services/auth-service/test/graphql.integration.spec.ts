/**
 * GraphQL integration tests for auth-service.
 *
 * Proves that:
 * 1. The live /graphql endpoint exposes `sessions`, `userLookup`, and
 *    `revokeSession` in the federated SDL (_service { sdl }).
 * 2. The `sessions` query resolves and correctly marks the current session
 *    using the `refreshToken` cookie name (not the old `refresh_token`).
 *
 * Spins up real Postgres and Redis via Testcontainers, bootstraps the full
 * NestJS app including AuthGraphQLModule, and exercises the endpoint over HTTP.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Logger, LoggerModule } from 'nestjs-pino';
import { z } from 'zod';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import * as fs from 'fs';
import * as path from 'path';
import supertest from 'supertest';
import cookieParser from 'cookie-parser';

import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { DatabaseModule } from '../src/database/database.module';
import { RedisModule } from '../src/modules/redis/redis.module';
import { AuthGraphQLModule } from '../src/graphql/graphql.module';

// ── Test RSA key (same as unit tests — not a real secret) ────────────────────
const TEST_RSA_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA8g+qzsBeAmIHAIqftMlCN4xNhjS/wG2oglQG8mgu5CqngEGo
ZdbrgUBMC22B2VGHJvvW/AxW24uEj0/+S5g00wlJ0UkqtkAGwjgW52DtykRz1tQN
9M0NKAWayweSNoySeNWfsqJfiB4R7BB+/fpq+nFKh78DdFDPifnBMuoy7s7QDQvP
DDiw9Uu+dWMswZqQncgite/sp/ZRpy8Ufc6t37HYPrwTfo5lUX8Isn0ZDUTeE+MQ
pUacP396AbKBH5cRy+lkzalZRuTs2MUvtpK4RosVB4IMHs+3rNATJWeEsteVBb1D
e91u/Old0xDI4FLaKxWlLmdjSMQrzcetjRQCuwIDAQABAoIBAEPiBunCYtrSONp7
BbzCcDJ5w0fuxROm7QnXnLcgZn4QRDcgsqQUuKjfqjPOOwsB5SAWojy/DSC2qK80
JMF4ZuAEC9KIbVT88ahH6Ixsz2LY/Y9ympNbaeQeZkGn1uY7V9xRNF75UEcw/5+v
JJ3/Oz8OxHL7K3HUM8+i3f50VWJIy8bUuLkXd5R4Cxc3X3hbgS1ozETLc797IOqT
yUOSg6PcOZnRvo9bnovxW9KHG7I37qzoQdA8+/HTZM2+fSuDG4jNbLrch2TEVxIX
NC1qLQLe+qsYXPhYiWmxZ2hydhTYnFCCs1EFSzfYNyvN4BfQio7mDd7WGB2V15wg
zRvxDXkCgYEA/IhBG+Fh5fVUlYKHHiz/G5FkC59nYwqG3q0apNbHFIovWnSW0pQk
bRbKHxh9TaM4vB5IdZLyfT2FzwZ8LpHTaj6jKXBE+OXbgK0W/X6LYreCLAgUcwUr
TJZ/p8I0em36AWhL47R7qPEWgsl9ybJb9wH//N0/TapFb7o+imGsat0CgYEA9WKa
baoeedKo7V74NjK6m9sKhIT61LTy+X4k7iLcbiKZ8PepFfGHdWMPZe7QQIKjHCOq
+eSWug2rvZo0/IrkG7hw0bW2P0svnjKHmGgpgojdSob0zixpUjiGsvv83PQxgpso
hzcuWDp+VadRnaO1+Sl+crhQlymo4YSJFA9rTncCgYAxTIA5ayRrehtLHLI4B9y9
iwKW6kWKpjFyIyUCbRNsRRW9eOlArr71tO88ZtF/aI/Y2aiXm1pPbMVEhyWTCdDV
+uhrXIl6dZUGZ8QHNL8NRHnbErC7S5UKXI8LNvR7uiCGSdAW4dMKRhZ47dDqoTEm
5XMN8Ds9dDId/6PZ6/t22QKBgHlElZUEsbL6zMkiWgBO6bIEehorrdpY4osyMAYP
7GfxaaqQeluB1bPJlN6HOxvmc72AUwrUUTj5cJpvDyiPa1PXvsmkx8BX49yGlERZ
lcoQ4WvnbixF/nbHwKnLppd7hsxI6aqJNrobjju+SLNjKJdOTlNbi1hpGjD5UtU7
GYjZAoGBALZlXBFKURFjACUw+HK2LmRwfPH/Cbw3h5F73+8j39wzhFEQ/ANjP7sB
J2I25W+YIYqYGV3OAYNcxcveSf6+WgKAKR5VQuQQQ0nOX0seFL1xnERfXqADgZyJ
iMbpvI5mi11tnbw8iU3T0jJycMgHw7EIiCNy2czPt2BRYcwIK9Gb
-----END RSA PRIVATE KEY-----`;

// ── Suite setup / teardown ────────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let pool: Pool;
let redisClient: Redis;
let request: ReturnType<typeof supertest>;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('auth_test')
    .withUsername('auth_user')
    .withPassword('auth_pass')
    .start();

  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  const databaseUrl = pgContainer.getConnectionUri();

  process.env['DATABASE_URL'] = databaseUrl;
  process.env['REDIS_URL'] = redisUrl;
  process.env['RSA_PRIVATE_KEY'] = TEST_RSA_PEM;
  process.env['JWT_EXPIRY'] = '15m';
  process.env['NODE_ENV'] = 'test';

  redisClient = new Redis(redisUrl);

  pool = new Pool({ connectionString: databaseUrl });
  const migration1Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/001_init_users.sql'),
    'utf-8',
  );
  await pool.query(migration1Sql);
  const migration2Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/002_add_roles.sql'),
    'utf-8',
  );
  await pool.query(migration2Sql);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validate: (config: Record<string, unknown>) => {
          const result = z
            .object({
              DATABASE_URL: z.string(),
              REDIS_URL: z.string(),
              RSA_PRIVATE_KEY: z.string(),
              JWT_EXPIRY: z.string().default('15m'),
              JWT_COOKIE_NAME: z.string().default('token'),
              REFRESH_COOKIE_NAME: z.string().default('refreshToken'),
              REFRESH_TOKEN_TTL_SECONDS: z
                .preprocess(
                  (value) =>
                    typeof value === 'string' ? Number(value.trim()) : value,
                  z.number().int().positive(),
                )
                .default(7 * 24 * 60 * 60),
              REFRESH_COOKIE_PATH: z.string().default('/'),
              ACCESS_TOKEN_COOKIE_SAME_SITE: z
                .enum(['strict', 'lax', 'none'])
                .default('strict'),
              REFRESH_TOKEN_COOKIE_SAME_SITE: z
                .enum(['strict', 'lax', 'none'])
                .default('strict'),
              COOKIE_DOMAIN: z.string().optional(),
              DB_POOL_MAX: z.coerce.number().int().positive().default(20),
              SIGNIN_FAILURE_WINDOW_SECONDS: z.coerce
                .number()
                .int()
                .positive()
                .default(15 * 60),
              SIGNIN_MAX_FAILURES: z.coerce
                .number()
                .int()
                .positive()
                .default(5),
              SIGNIN_LOCKOUT_SECONDS: z.coerce
                .number()
                .int()
                .positive()
                .default(15 * 60),
              NODE_ENV: z.string().default('test'),
              KONG_BASE_URL: z.string().url().default('http://localhost:8000'),
              OAUTH_CLIENT_BASE_URL: z
                .string()
                .url()
                .default('http://localhost:4000'),
              X_USER_ID_SIGNING_KEY: z.string().optional().default(''),
            })
            .safeParse(config);
          if (!result.success) throw new Error(result.error.message);
          return result.data;
        },
        ignoreEnvFile: true,
      }),
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      DatabaseModule,
      RedisModule,
      AuthGraphQLModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(moduleRef.get(Logger)));
  await app.init();
  request = supertest(app.getHttpServer() as Parameters<typeof supertest>[0]);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await redisClient?.quit();
  await pool?.end();
  await pgContainer?.stop();
  await redisContainer?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  await redisClient.flushdb();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function getCookieValue(
  setCookieHeaders: string | string[] | undefined,
  name: string,
): string | undefined {
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

// ── GraphQL SDL wiring tests ──────────────────────────────────────────────────

describe('GraphQL SDL wiring: _service { sdl }', () => {
  it('exposes sessions on the Query type', async () => {
    const res = await request
      .post('/graphql')
      .send({ query: '{ _service { sdl } }' });

    expect(res.status).toBe(200);
    const sdl: string = res.body.data._service.sdl;
    expect(sdl).toMatch(/sessions/);
  });

  it('exposes userLookup on the Query type', async () => {
    const res = await request
      .post('/graphql')
      .send({ query: '{ _service { sdl } }' });

    expect(res.status).toBe(200);
    const sdl: string = res.body.data._service.sdl;
    expect(sdl).toMatch(/userLookup/);
  });

  it('exposes revokeSession on the Mutation type', async () => {
    const res = await request
      .post('/graphql')
      .send({ query: '{ _service { sdl } }' });

    expect(res.status).toBe(200);
    const sdl: string = res.body.data._service.sdl;
    expect(sdl).toMatch(/revokeSession/);
  });
});

// ── sessions query tests ──────────────────────────────────────────────────────

describe('GraphQL query { sessions }', () => {
  it('returns an error when X-User-Id is missing', async () => {
    const res = await request
      .post('/graphql')
      .send({ query: '{ sessions { id current } }' });

    expect(res.status).toBe(200);
    // GraphQL returns errors in body even on HTTP 200; the sessions resolver
    // requires X-User-Id so the query must not succeed silently.
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('returns sessions and marks the current one using the refreshToken cookie', async () => {
    // Sign up to create a session with a refreshToken cookie.
    const signupRes = await request
      .post('/api/users/signup')
      .send({ email: 'gql-sessions@example.com', password: 'password123' });
    expect(signupRes.status).toBe(201);

    const setCookieHeaders = signupRes.headers['set-cookie'] as unknown as
      string[] | undefined;
    const refreshTokenValue = getCookieValue(setCookieHeaders, 'refreshToken');
    const accessTokenValue = getCookieValue(setCookieHeaders, 'token');
    expect(refreshTokenValue).toBeDefined();
    expect(accessTokenValue).toBeDefined();

    // Retrieve the user ID via the REST currentuser endpoint.
    const meRes = await request
      .get('/api/users/currentuser')
      .set('Cookie', `token=${accessTokenValue!}`);
    expect(meRes.status).toBe(200);
    const userId: string = meRes.body.currentUser.id;
    expect(userId).toBeTruthy();

    // Query sessions over GraphQL with the X-User-Id header and refreshToken cookie.
    const gqlRes = await request
      .post('/graphql')
      .set('X-User-Id', userId)
      .set('Cookie', `refreshToken=${refreshTokenValue!}`)
      .send({ query: '{ sessions { id current createdAt } }' });

    expect(gqlRes.status).toBe(200);
    expect(gqlRes.body.errors).toBeUndefined();

    const sessions: Array<{ id: string; current: boolean; createdAt: string }> =
      gqlRes.body.data.sessions;
    expect(sessions).toHaveLength(1);
    // The refreshToken cookie must identify the session as current.
    expect(sessions[0].current).toBe(true);
  });
});
