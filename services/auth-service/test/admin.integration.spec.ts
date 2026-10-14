/**
 * Integration tests for platform role management: real PostgreSQL and Redis,
 * the real NestJS app, real HTTP. Roles and audit rows are read straight from
 * the database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Logger, LoggerModule } from 'nestjs-pino';
import { generateKeyPairSync } from 'crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as fs from 'fs';
import * as path from 'path';
import supertest from 'supertest';
import cookieParser from 'cookie-parser';

import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import * as schema from '../src/database/schema';
import { DatabaseModule } from '../src/database/database.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AdminModule } from '../src/modules/admin/admin.module';
import { grantRoleByEmail } from '../src/modules/admin/grant-role.cli';

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let pool: Pool;
let redisClient: Redis;
let request: ReturnType<typeof supertest>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
  process.env['REDIS_URL'] = redisUrl;
  process.env['RSA_PRIVATE_KEY'] = privateKey;
  process.env['DB_POOL_MAX'] = '5';
  process.env['NODE_ENV'] = 'test';

  redisClient = new Redis(redisUrl);
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  const dir = path.join(__dirname, '../migrations');
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf-8'));
  }
  db = drizzle(pool, { schema });

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      DatabaseModule,
      AuthModule,
      AdminModule,
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
}, 90_000);

afterAll(async () => {
  await app?.close();
  await redisClient?.quit();
  await pool?.end();
  await pgContainer?.stop();
  await redisContainer?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users, audit_log RESTART IDENTITY CASCADE');
  await redisClient.flushdb();
});

function cookie(res: supertest.Response, name: string): string {
  const headers = res.headers['set-cookie'] as unknown as string[];
  const hit = headers.find((c) => c.startsWith(`${name}=`));
  return hit!.split(';')[0];
}

async function signUp(email: string) {
  const res = await request
    .post('/api/users/signup')
    .send({ email, password: 'password123' });
  const row = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );
  return {
    id: row.rows[0].id,
    token: cookie(res, 'token'),
    refresh: cookie(res, 'refreshToken'),
  };
}

async function signIn(email: string) {
  const res = await request
    .post('/api/users/signin')
    .send({ email, password: 'password123' });
  return { token: cookie(res, 'token'), refresh: cookie(res, 'refreshToken') };
}

async function adminSession() {
  const admin = await signUp('admin@example.com');
  await grantRoleByEmail(db, 'admin@example.com', 'platform_admin', 'cli:test');
  return { id: admin.id, ...(await signIn('admin@example.com')) };
}

const rolesOf = async (id: string): Promise<string[]> =>
  (
    await pool.query<{ roles: string[] }>(
      'SELECT roles FROM users WHERE id=$1',
      [id],
    )
  ).rows[0].roles;
const auditRows = async (): Promise<Record<string, unknown>[]> =>
  (
    await pool.query<Record<string, unknown>>(
      'SELECT * FROM audit_log ORDER BY at',
    )
  ).rows;

function claimsOf(cookieHeader: string): { roles?: string[] } {
  const jwt = cookieHeader.split('=')[1];
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as {
    roles?: string[];
  };
}

const grantBody = {
  role: 'platform_support',
  action: 'grant',
  reason: 'joins the support rota',
};

describe('only a platform admin can grant roles', () => {
  it("should let a platform admin grant a role that then appears in the target user's next token", async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');

    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send(grantBody);

    expect(res.status).toBe(200);
    expect(await rolesOf(target.id)).toEqual(['platform_support']);
    expect(claimsOf((await signIn('target@example.com')).token).roles).toEqual([
      'platform_support',
    ]);
  });

  it('should refuse a signed-in user who holds no platform role', async () => {
    const buyer = await signUp('buyer@example.com');
    const target = await signUp('target@example.com');

    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', buyer.token)
      .send(grantBody);

    expect(res.status).toBe(403);
    expect(await rolesOf(target.id)).toEqual([]);
  });

  it('should refuse platform support, who cannot grant roles', async () => {
    const admin = await adminSession();
    const support = await signUp('support@example.com');
    await request
      .post(`/admin/users/${support.id}/roles`)
      .set('Cookie', admin.token)
      .send(grantBody);
    const supportSession = await signIn('support@example.com');
    const target = await signUp('target@example.com');

    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', supportSession.token)
      .send(grantBody);

    expect(res.status).toBe(403);
  });

  it('should ignore an X-User-Roles header from a caller who is not an admin', async () => {
    const buyer = await signUp('buyer@example.com');
    const res = await request
      .post(`/admin/users/${buyer.id}/roles`)
      .set('Cookie', buyer.token)
      .set('X-User-Roles', 'platform_admin')
      .send({ ...grantBody, role: 'platform_admin' });

    expect(res.status).toBe(403);
    expect(await rolesOf(buyer.id)).toEqual([]);
  });

  it('should stop honouring an admin the moment their role is removed, even with a still-valid token', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    await pool.query("UPDATE users SET roles = '[]' WHERE id = $1", [admin.id]);

    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send(grantBody);

    expect(res.status).toBe(403);
  });

  it('should reject a request with no credentials', async () => {
    const target = await signUp('target@example.com');
    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .send(grantBody);
    expect(res.status).toBe(401);
  });
});

describe('role change requests are validated', () => {
  it('should reject an unknown role name without touching the user', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send({ ...grantBody, role: 'organizer' });
    expect(res.status).toBe(400);
    expect(await rolesOf(target.id)).toEqual([]);
  });

  it('should reject a change with no reason', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send({ role: 'platform_support', action: 'grant' });
    expect(res.status).toBe(400);
  });

  it('should answer 404 for a user that does not exist', async () => {
    const admin = await adminSession();
    const res = await request
      .post('/admin/users/33333333-3333-4333-8333-333333333333/roles')
      .set('Cookie', admin.token)
      .send(grantBody);
    expect(res.status).toBe(404);
  });
});

describe("removing a role revokes the user's refresh tokens", () => {
  it('should stop the removed user from refreshing into a new access token', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send(grantBody);
    const session = await signIn('target@example.com');
    expect(
      (await request.post('/api/auth/refresh').set('Cookie', session.refresh))
        .status,
    ).toBe(200);

    const res = await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send({ ...grantBody, action: 'remove', reason: 'left the team' });

    expect(res.status).toBe(200);
    expect(await rolesOf(target.id)).toEqual([]);
    const refreshed = await request
      .post('/api/auth/refresh')
      .set('Cookie', session.refresh);
    expect(refreshed.status).toBe(401);
  });

  it("should keep the user's refresh tokens when a role is only granted", async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    const session = await signIn('target@example.com');

    await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send(grantBody);

    expect(
      (await request.post('/api/auth/refresh').set('Cookie', session.refresh))
        .status,
    ).toBe(200);
  });
});

describe('every change is audited', () => {
  it('should record who changed what, why, and the roles before and after', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');

    await request
      .post(`/admin/users/${target.id}/roles`)
      .set('Cookie', admin.token)
      .send(grantBody);

    const rows = await auditRows();
    const row = rows[rows.length - 1];
    expect(row).toMatchObject({
      actor_user_id: admin.id,
      action: 'platform_role.grant',
      resource: `user:${target.id}`,
      before: { roles: [] },
      after: { roles: ['platform_support'] },
      reason: 'joins the support rota',
    });
  });

  it('should audit a removal as its own entry', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    const url = `/admin/users/${target.id}/roles`;
    await request.post(url).set('Cookie', admin.token).send(grantBody);
    await request
      .post(url)
      .set('Cookie', admin.token)
      .send({ ...grantBody, action: 'remove', reason: 'left the team' });

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual([
      'platform_role.grant', // the CLI bootstrap of the admin
      'platform_role.grant',
      'platform_role.remove',
    ]);
    expect(rows[2]).toMatchObject({
      before: { roles: ['platform_support'] },
      after: { roles: [] },
      reason: 'left the team',
    });
  });

  it('should write no audit row when the change alters nothing', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    const url = `/admin/users/${target.id}/roles`;
    await request.post(url).set('Cookie', admin.token).send(grantBody);
    const before = (await auditRows()).length;

    await request.post(url).set('Cookie', admin.token).send(grantBody);

    expect((await auditRows()).length).toBe(before);
  });

  it('should roll the role change back when its audit row cannot be written', async () => {
    const admin = await adminSession();
    const target = await signUp('target@example.com');
    await pool.query('ALTER TABLE audit_log RENAME TO audit_log_off');
    try {
      const res = await request
        .post(`/admin/users/${target.id}/roles`)
        .set('Cookie', admin.token)
        .send(grantBody);
      expect(res.status).toBe(500);
      expect(await rolesOf(target.id)).toEqual([]);
    } finally {
      await pool.query('ALTER TABLE audit_log_off RENAME TO audit_log');
    }
  });
});

describe('the operator CLI bootstrap', () => {
  it('should make the first admin and audit it with a cli actor and no user id', async () => {
    const user = await signUp('first@example.com');

    await grantRoleByEmail(
      db,
      'First@Example.com',
      'platform_admin',
      'cli:ops',
    );

    expect(await rolesOf(user.id)).toEqual(['platform_admin']);
    expect(await auditRows()).toMatchObject([
      {
        actor_user_id: 'cli:ops',
        action: 'platform_role.grant',
        resource: `user:${user.id}`,
        reason: 'bootstrap via admin:grant-role',
      },
    ]);
  });

  it('should refuse an unknown role and an unknown email', async () => {
    await signUp('first@example.com');
    await expect(
      grantRoleByEmail(db, 'first@example.com', 'organizer', 'cli:ops'),
    ).rejects.toThrow(/Unknown role/);
    await expect(
      grantRoleByEmail(db, 'nobody@example.com', 'platform_admin', 'cli:ops'),
    ).rejects.toThrow(/No user/);
    expect(await auditRows()).toEqual([]);
  });
});
