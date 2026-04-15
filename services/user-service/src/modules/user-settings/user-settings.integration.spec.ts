import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import * as fs from "fs";
import * as path from "path";
import type { AppModule as UserServiceAppModule } from "../../app.module";
import { configureApp } from "../../app.setup";

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let app: INestApplication;
let baseUrl: string;

async function requestJson<T = unknown>(
  pathName: string,
  options?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${pathName}`, options);
  const body = (await res.json().catch(() => null)) as T;
  return { status: res.status, body };
}

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("users_test")
    .withUsername("users_user")
    .withPassword("users_pass")
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;
  process.env.DB_POOL_MAX = "5";
  process.env.NODE_ENV = "test";

  pool = new Pool({ connectionString: databaseUrl });
  const migrationSql = fs.readFileSync(
    path.join(__dirname, "../../../migrations/001_init_user_settings.sql"),
    "utf-8",
  );
  await pool.query(migrationSql);

  const { AppModule } = (await import("../../app.module.js")) as {
    AppModule: typeof UserServiceAppModule;
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.listen(0);
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await pgContainer?.stop();
});

beforeEach(async () => {
  await pool.query("DELETE FROM billing_addresses");
  await pool.query("DELETE FROM user_preferences");
  await pool.query("DELETE FROM user_profiles");
});

describe("user-service integration", () => {
  it("GET /healthz/live returns 200", async () => {
    const result = await requestJson("/healthz/live");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok" });
  });

  it("GET /healthz/ready returns 200 when DB is reachable", async () => {
    const result = await requestJson("/healthz/ready");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok" });
  });

  it("GET /api/user-settings/profile rejects requests without X-User-Id", async () => {
    const result = await requestJson("/api/user-settings/profile");
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: "MISSING_USER_ID",
      },
    });
  });

  it("profile/preferences/billing endpoints persist data for the caller", async () => {
    const userId = "integration-user-1";

    const profileUpdate = await requestJson("/api/user-settings/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-id": userId,
      },
      body: JSON.stringify({
        displayName: "Taylor",
        locale: "en-US",
        timezone: "UTC",
      }),
    });
    expect(profileUpdate.status).toBe(200);

    const preferencesUpdate = await requestJson(
      "/api/user-settings/preferences",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          marketingOptIn: true,
          orderUpdates: false,
          productUpdates: true,
        }),
      },
    );
    expect(preferencesUpdate.status).toBe(200);

    const billingUpdate = await requestJson(
      "/api/user-settings/billing-address",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          line1: "123 Main St",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        }),
      },
    );
    expect(billingUpdate.status).toBe(200);

    const profileRead = await requestJson<{ profile: { displayName: string } }>(
      "/api/user-settings/profile",
      {
        headers: {
          "x-user-id": userId,
        },
      },
    );
    expect(profileRead.status).toBe(200);
    expect(profileRead.body.profile.displayName).toBe("Taylor");

    const preferencesRead = await requestJson<{
      preferences: {
        marketingOptIn: boolean;
        orderUpdates: boolean;
        productUpdates: boolean;
      };
    }>("/api/user-settings/preferences", {
      headers: {
        "x-user-id": userId,
      },
    });
    expect(preferencesRead.status).toBe(200);
    expect(preferencesRead.body.preferences).toMatchObject({
      marketingOptIn: true,
      orderUpdates: false,
      productUpdates: true,
    });

    const billingRead = await requestJson<{
      billingAddress: {
        line1: string;
        city: string;
        state: string;
        postalCode: string;
        country: string;
      };
    }>("/api/user-settings/billing-address", {
      headers: {
        "x-user-id": userId,
      },
    });
    expect(billingRead.status).toBe(200);
    expect(billingRead.body.billingAddress).toMatchObject({
      line1: "123 Main St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });
  });

  it("rejects unknown fields with the production validation contract", async () => {
    const result = await requestJson("/api/user-settings/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-id": "integration-user-unknown-field",
      },
      body: JSON.stringify({
        displayName: "Taylor",
        role: "admin",
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
      },
    });
  });

  it("rejects invalid boolean payloads for preferences", async () => {
    const result = await requestJson("/api/user-settings/preferences", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-id": "integration-user-invalid-pref",
      },
      body: JSON.stringify({
        marketingOptIn: "yes",
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
      },
    });
  });

  it("rejects malformed billing payloads", async () => {
    const result = await requestJson("/api/user-settings/billing-address", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-id": "integration-user-invalid-billing",
      },
      body: JSON.stringify({
        line1: ["123 Main St"],
        postalCode: 78701,
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
      },
    });
  });
});
