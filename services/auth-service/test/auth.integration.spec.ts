/**
 * Integration tests for the auth-service HTTP API.
 *
 * Spins up a real PostgreSQL container and a real Redis container via
 * Testcontainers, applies the SQL migration, bootstraps the full NestJS
 * application, and exercises the endpoints over real HTTP using supertest.
 *
 * Each test runs against a clean database: beforeEach truncates the users
 * table and flushes Redis so no state leaks between tests (T-10).
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import * as Joi from 'joi';
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
import { AuthModule } from '../src/modules/auth/auth.module';
import { HealthModule } from '../src/modules/health/health.module';

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
  // 1. Start PostgreSQL container
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('auth_test')
    .withUsername('auth_user')
    .withPassword('auth_pass')
    .start();

  // 2. Start Redis container
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

  // 3. Connect a direct Redis client for per-test cleanup (FLUSHDB).
  redisClient = new Redis(redisUrl);

  // 4. Apply migration using raw SQL
  pool = new Pool({ connectionString: databaseUrl });
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '../migrations/001_init_users.sql'),
    'utf-8',
  );
  await pool.query(migrationSql);

  // 5. Bootstrap NestJS app (without pino/metrics to keep tests simple)
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validationSchema: Joi.object({
          DATABASE_URL: Joi.string().required(),
          REDIS_URL: Joi.string().required(),
          RSA_PRIVATE_KEY: Joi.string().required(),
          JWT_EXPIRY: Joi.string().default('15m'),
          NODE_ENV: Joi.string().default('test'),
        }),
        ignoreEnvFile: true,
      }),
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      DatabaseModule,
      AuthModule,
      HealthModule,
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
  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.init();
  request = supertest(app.getHttpServer());
}, 90_000);

afterAll(async () => {
  await app?.close();
  await redisClient?.quit();
  await pool?.end();
  await pgContainer?.stop();
  await redisContainer?.stop();
});

/**
 * Per-test isolation (T-10): truncate the users table and flush Redis before
 * every test. This guarantees tests are fully independent regardless of
 * execution order — no leftover rows or blacklisted JTIs from prior tests.
 */
beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  await redisClient.flushdb();
});

// ── Helper ────────────────────────────────────────────────────────────────────

/** Extract a named cookie value from a Set-Cookie header array. */
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/users/signup returns 201 Created given valid credentials', () => {
  it('should set an httpOnly token cookie and return the current user email', async () => {
    const res = await request
      .post('/api/users/signup')
      .send({ email: 'signup@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.currentUser.email).toBe('signup@example.com');
    const setCookieHeaders = res.headers['set-cookie'] as string[] | undefined;
    expect(setCookieHeaders).toBeDefined();
    const tokenCookie = setCookieHeaders!.find((c) => c.startsWith('token='));
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toMatch(/HttpOnly/i);
  });

  it('should also set an httpOnly refreshToken cookie scoped to /api/auth/refresh', async () => {
    const res = await request
      .post('/api/users/signup')
      .send({ email: 'signup-refresh@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    const setCookieHeaders = res.headers['set-cookie'] as string[] | undefined;
    expect(setCookieHeaders).toBeDefined();
    const refreshCookie = setCookieHeaders!.find((c) =>
      c.startsWith('refreshToken='),
    );
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/Path=\/api\/auth\/refresh/i);
  });
});

describe('POST /api/users/signup returns 409 Conflict given duplicate email', () => {
  it('should reject a second signup with the same email', async () => {
    // First signup — seeds data
    await request
      .post('/api/users/signup')
      .send({ email: 'dup@example.com', password: 'password123' });

    // Second signup — should conflict
    const res = await request
      .post('/api/users/signup')
      .send({ email: 'dup@example.com', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
  });
});

describe('POST /api/users/signup returns 400 Bad Request given invalid input', () => {
  it('should reject a non-email address', async () => {
    const res = await request
      .post('/api/users/signup')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('should reject a password shorter than 8 characters', async () => {
    const res = await request
      .post('/api/users/signup')
      .send({ email: 'short@example.com', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('should reject unknown extra fields', async () => {
    const res = await request.post('/api/users/signup').send({
      email: 'extra@example.com',
      password: 'password123',
      admin: true,
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/users/signin returns 200 OK given valid credentials', () => {
  it('should set token and refreshToken cookies when credentials are correct', async () => {
    const email = 'signin@example.com';
    const password = 'password123';

    await request.post('/api/users/signup').send({ email, password });
    const res = await request
      .post('/api/users/signin')
      .send({ email, password });

    expect(res.status).toBe(200);
    const setCookieHeaders = res.headers['set-cookie'] as string[] | undefined;
    expect(setCookieHeaders).toBeDefined();
    const tokenCookie = setCookieHeaders!.find((c) => c.startsWith('token='));
    const refreshCookie = setCookieHeaders!.find((c) =>
      c.startsWith('refreshToken='),
    );
    expect(tokenCookie).toBeDefined();
    expect(refreshCookie).toBeDefined();
  });
});

describe('POST /api/users/signin returns 401 Unauthorized given wrong credentials', () => {
  it('should reject an unknown email', async () => {
    const res = await request
      .post('/api/users/signin')
      .send({ email: 'nobody@example.com', password: 'password123' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('should reject a wrong password', async () => {
    await request
      .post('/api/users/signup')
      .send({ email: 'wrongpass@example.com', password: 'correctpassword' });

    const res = await request
      .post('/api/users/signin')
      .send({ email: 'wrongpass@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('POST /api/auth/refresh rotates refresh token', () => {
  it('should return 401 when no refreshToken cookie is present', async () => {
    const res = await request.post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_REFRESH_TOKEN');
  });

  it('should return 401 for an invalid refresh token', async () => {
    const res = await request
      .post('/api/auth/refresh')
      .set('Cookie', 'refreshToken=not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('should issue new token cookies and rotate the refresh token', async () => {
    // Sign up to get a refresh token
    const signupRes = await request
      .post('/api/users/signup')
      .send({ email: 'refresh-rotate@example.com', password: 'password123' });
    expect(signupRes.status).toBe(201);

    const signupCookies = signupRes.headers['set-cookie'] as string[];
    const oldRefreshTokenValue = getCookieValue(signupCookies, 'refreshToken');
    expect(oldRefreshTokenValue).toBeDefined();

    // Use the refresh token to get a new access token
    const refreshRes = await request
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${oldRefreshTokenValue!}`);

    expect(refreshRes.status).toBe(200);
    const refreshCookies = refreshRes.headers['set-cookie'] as string[];
    const newTokenValue = getCookieValue(refreshCookies, 'token');
    const newRefreshTokenValue = getCookieValue(refreshCookies, 'refreshToken');
    expect(newTokenValue).toBeDefined();
    expect(newRefreshTokenValue).toBeDefined();
    // Refresh token should be rotated (different value)
    expect(newRefreshTokenValue).not.toBe(oldRefreshTokenValue);
  });

  it('should reject a refresh token after it has been rotated (replay prevention)', async () => {
    // Sign up and get initial refresh token
    const signupRes = await request
      .post('/api/users/signup')
      .send({ email: 'refresh-replay@example.com', password: 'password123' });
    expect(signupRes.status).toBe(201);

    const signupCookies = signupRes.headers['set-cookie'] as string[];
    const originalRefreshToken = getCookieValue(signupCookies, 'refreshToken');
    expect(originalRefreshToken).toBeDefined();

    // First rotation — should succeed
    const firstRefreshRes = await request
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${originalRefreshToken!}`);
    expect(firstRefreshRes.status).toBe(200);

    // Replay with the old token — should now be rejected
    const replayRes = await request
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${originalRefreshToken!}`);
    expect(replayRes.status).toBe(401);
    expect(replayRes.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('POST /api/users/signout returns 204 No Content', () => {
  it('should clear the token cookie', async () => {
    const res = await request.post('/api/users/signout');

    expect(res.status).toBe(204);
    // Cookie header should contain an expired/empty token cookie
    const cookie =
      ((res.headers['set-cookie'] as string[] | undefined) ?? [])[0] ?? '';
    expect(cookie).toMatch(/token=/);
  });

  it('should revoke the refresh token so it cannot be used after signout', async () => {
    // Sign up to get a refresh token
    const signupRes = await request.post('/api/users/signup').send({
      email: 'signout-revoke@example.com',
      password: 'password123',
    });
    expect(signupRes.status).toBe(201);

    const signupCookies = signupRes.headers['set-cookie'] as string[];
    const refreshTokenValue = getCookieValue(signupCookies, 'refreshToken');
    expect(refreshTokenValue).toBeDefined();

    // Sign out while sending the refresh token cookie
    const signoutRes = await request
      .post('/api/users/signout')
      .set('Cookie', `refreshToken=${refreshTokenValue!}`);
    expect(signoutRes.status).toBe(204);

    // Attempting to use the revoked refresh token should now fail
    const refreshRes = await request
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${refreshTokenValue!}`);
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('GET /api/users/currentuser', () => {
  it('should return null when no X-User-Id header is present', async () => {
    const res = await request.get('/api/users/currentuser');

    expect(res.status).toBe(200);
    expect(res.body.currentUser).toBeNull();
  });

  it('should return the user id when X-User-Id header is injected', async () => {
    const res = await request
      .get('/api/users/currentuser')
      .set('X-User-Id', 'some-uuid-from-kong');

    expect(res.status).toBe(200);
    expect(res.body.currentUser.id).toBe('some-uuid-from-kong');
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('should return a valid JWKS with one RS256 key', async () => {
    const res = await request.get('/.well-known/jwks.json');

    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].alg).toBe('RS256');
    expect(res.body.keys[0].use).toBe('sig');
  });
});

describe('GET /healthz/live', () => {
  it('should return 200 OK', async () => {
    const res = await request.get('/healthz/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /healthz/ready', () => {
  it('should return 200 OK when database is reachable', async () => {
    const res = await request.get('/healthz/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
