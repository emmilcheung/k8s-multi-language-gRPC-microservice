import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import * as fs from "fs";
import * as path from "path";
import * as schema from "../../database/schema";
import * as audit from "./audit";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const dir = path.join(__dirname, "../../../migrations");
  for (const file of fs.readdirSync(dir).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), "utf-8"));
  }
  db = drizzle(pool, { schema });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query("DELETE FROM audit_log");
  await pool.query("DELETE FROM organizer_accounts");
});

const count = async (table: string) =>
  Number(
    (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))
      .rows[0].n,
  );

const entry = {
  actorUserId: "user-1",
  actorAccountId: "acct-1",
  action: "account.rename",
  resource: "account:acct-1",
  before: { name: "Old" },
  after: { name: "New" },
  reason: "typo",
  traceId: "trace-1",
};

describe("audit (PostgreSQL)", () => {
  it("a command and its audit row commit together", async () => {
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.organizerAccounts)
        .values({ name: "New", createdBy: "user-1" });
      await audit.record(tx, entry);
    });
    expect(await count("organizer_accounts")).toBe(1);
    const rows = await pool.query<{ at: Date }>(
      "SELECT * FROM audit_log WHERE action = 'account.rename'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      actor_user_id: "user-1",
      actor_account_id: "acct-1",
      resource: "account:acct-1",
      before: { name: "Old" },
      after: { name: "New" },
      reason: "typo",
      trace_id: "trace-1",
    });
    expect(rows.rows[0].at).toBeInstanceOf(Date);
  });

  it("a command that fails leaves neither its change nor its audit row", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(schema.organizerAccounts)
          .values({ name: "New", createdBy: "user-1" });
        await audit.record(tx, entry);
        throw new Error("command failed after auditing");
      }),
    ).rejects.toThrow("command failed");
    expect(await count("organizer_accounts")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });

  it("an audit row that cannot be written rolls the command back", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(schema.organizerAccounts)
          .values({ name: "New", createdBy: "user-1" });
        await audit.record(tx, { ...entry, actorUserId: null as never });
      }),
    ).rejects.toThrow();
    expect(await count("organizer_accounts")).toBe(0);
  });

  it("stored audit rows never contain attendee names or emails", async () => {
    await db.transaction((tx) =>
      audit.record(tx, {
        ...entry,
        before: { attendeeName: "Ada", seats: 1 },
        after: { attendeeEmail: "ada@example.com", seats: 2 },
      }),
    );
    const { rows } = await pool.query<{ after: unknown }>(
      "SELECT before, after FROM audit_log",
    );
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("ada@example.com");
    expect(rows[0].after).toEqual({ attendeeEmail: "[redacted]", seats: 2 });
  });
});
