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
import type { AccountsService as AccountsServiceType } from "./accounts.service";
import { Roles } from "./roles";

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let app: INestApplication;
let service: AccountsServiceType;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("users_test")
    .withUsername("users_user")
    .withPassword("users_pass")
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;
  process.env.DB_POOL_MAX = "10";
  process.env.NODE_ENV = "test";

  pool = new Pool({ connectionString: databaseUrl });
  const migrationsDir = path.join(__dirname, "../../../migrations");
  for (const file of fs.readdirSync(migrationsDir).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), "utf-8"));
  }

  const { AppModule } = (await import("../../app.module.js")) as {
    AppModule: typeof UserServiceAppModule;
  };
  const { AccountsService } = (await import("./accounts.service.js")) as {
    AccountsService: typeof AccountsServiceType;
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  service = moduleRef.get(AccountsService, { strict: false });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await pgContainer?.stop();
});

beforeEach(async () => {
  await pool.query("DELETE FROM venue_claims");
  await pool.query("DELETE FROM invitations");
  await pool.query("DELETE FROM memberships");
  await pool.query("DELETE FROM organizer_accounts");
  await pool.query("DELETE FROM user_profiles");
  await pool.query("DELETE FROM audit_log");
});

const count = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query<{ n: string }>(sql, params)).rows[0].n);

describe("accounts (PostgreSQL)", () => {
  it("two owners stepping down at the same moment still leave one owner", async () => {
    const account = await service.createAccount({
      name: "Acme",
      createdBy: "o1",
    });
    await service.addMember(account.id, "o1", "o2", Roles.OWNER);

    const results = await Promise.allSettled([
      service.changeRole(account.id, "o1", "o1", Roles.ADMIN),
      service.changeRole(account.id, "o2", "o2", Roles.ADMIN),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM memberships WHERE resource_id = $1 AND role = 'OWNER'",
        [account.id],
      ),
    ).toBe(1);
  });

  it("concurrent requests for a personal account create exactly one", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.ensurePersonalAccount("u1", "Ada"),
      ),
    );

    expect(new Set(ids).size).toBe(1);
    expect(await count("SELECT count(*) AS n FROM organizer_accounts")).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM memberships WHERE user_id = 'u1' AND role = 'OWNER'",
      ),
    ).toBe(1);
  });

  it("removing a door staff member also removes their event limits", async () => {
    const account = await service.createAccount({
      name: "Acme",
      createdBy: "o1",
    });
    await service.addMember(account.id, "o1", "door", Roles.DOOR_STAFF);
    await service.setEventScopes(account.id, "o1", "door", ["e1", "e2"]);
    expect(
      await count("SELECT count(*) AS n FROM membership_event_scopes"),
    ).toBe(2);

    await service.removeMember(account.id, "o1", "door");

    expect(
      await count("SELECT count(*) AS n FROM membership_event_scopes"),
    ).toBe(0);
  });

  it("replacing event limits keeps only the new list", async () => {
    const account = await service.createAccount({
      name: "Acme",
      createdBy: "o1",
    });
    await service.addMember(account.id, "o1", "door", Roles.DOOR_STAFF);
    await service.setEventScopes(account.id, "o1", "door", ["e1", "e2"]);
    await service.setEventScopes(account.id, "o1", "door", ["e3"]);

    const { rows } = await pool.query<{ event_id: string }>(
      "SELECT event_id FROM membership_event_scopes",
    );
    expect(rows.map((r) => r.event_id)).toEqual(["e3"]);
  });

  it("the database itself refuses a duplicate membership and an unknown role", async () => {
    const account = await service.createAccount({
      name: "Acme",
      createdBy: "o1",
    });
    const insert = (role: string) =>
      pool.query(
        `INSERT INTO memberships (user_id, resource_type, resource_id, role, created_by)
         VALUES ('o1', 'ORGANIZER_ACCOUNT', $1, $2, 'o1')`,
        [account.id, role],
      );
    await expect(insert("ADMIN")).rejects.toThrow(
      /memberships_user_resource_key/,
    );
    await expect(
      pool.query(
        `INSERT INTO memberships (user_id, resource_type, resource_id, role, created_by)
         VALUES ('x', 'ORGANIZER_ACCOUNT', $1, 'GOD', 'x')`,
        [account.id],
      ),
    ).rejects.toThrow(/check/);
  });

  it("an invitation starts pending, expires in 7 days and its token hash cannot be reused", async () => {
    const account = await service.createAccount({
      name: "Acme",
      createdBy: "o1",
    });
    const insert = () =>
      pool.query<{ status: string; ttl: { days: number } }>(
        `INSERT INTO invitations (account_id, email, role, token_hash, created_by)
         VALUES ($1, 'a@b.c', 'ADMIN', 'hash-1', 'o1')
         RETURNING status, expires_at - created_at AS ttl`,
        [account.id],
      );
    const { rows } = await insert();
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].ttl).toMatchObject({ days: 7 });
    await expect(insert()).rejects.toThrow(/token_hash/);
  });

  it("a venue claim records the claiming user and may omit the account", async () => {
    const { rows } = await pool.query(
      `INSERT INTO venue_claims (venue_id, claimant_user_id, evidence_text)
       VALUES ('v1', 'u1', 'we run it') RETURNING status, claimant_account_id`,
    );
    expect(rows[0]).toEqual({ status: "PENDING", claimant_account_id: null });
  });

  it("a personal account created without a name takes the owner's profile display name", async () => {
    await pool.query(
      "INSERT INTO user_profiles (user_id, display_name) VALUES ('u1', 'Ada Lovelace')",
    );

    const id = await service.ensurePersonalAccount("u1");

    expect((await service.getAccount(id)).name).toBe("Ada Lovelace");
  });

  it("a personal account for someone with no profile name falls back to a generic name", async () => {
    const id = await service.ensurePersonalAccount("no-profile");

    expect((await service.getAccount(id)).name).toBe("Personal account");
  });

  it("making someone venue manager twice leaves one membership and one audit row", async () => {
    await service.ensureVenueManager("u1", "venue-1");
    await service.ensureVenueManager("u1", "venue-1");

    expect(
      await count(
        "SELECT count(*) AS n FROM memberships WHERE user_id = 'u1' AND resource_type = 'VENUE' AND resource_id = 'venue-1' AND role = 'VENUE_MANAGER'",
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'venue.manager_ensured' AND resource = 'venue:venue-1'",
      ),
    ).toBe(1);
  });
});
