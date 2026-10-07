import crypto from "crypto";
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
import type { AppModule as UserServiceAppModule } from "../app.module";
import type { AccountsResolver as AccountsResolverType } from "./accounts.resolver";

const KEY = "integration-signing-key-0123456789abcdef";

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let app: INestApplication;
let api: AccountsResolverType;

function as(userId: string, platformRoles?: string) {
  const headers: Record<string, string> = { "x-user-id": userId };
  if (platformRoles) {
    const minute = Math.floor(Date.now() / 1000 / 60);
    headers["x-user-roles"] = platformRoles;
    headers["x-user-roles-sig"] = crypto
      .createHmac("sha256", KEY)
      .update(`${userId}|${platformRoles}|${minute}`)
      .digest("base64");
  }
  return { req: { headers } } as never;
}
const admin = (id = "admin") => as(id, "platform_admin");

async function newAccount(owner = "o1", name = "Acme") {
  const res = await api.createOrganizerAccount({ name }, as(owner));
  expect(res.userErrors).toEqual([]);
  return res.account!.id;
}

const EVENT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVENT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

async function invite(
  accountId: string,
  email: string,
  role: "ADMIN" | "DOOR_STAFF" | "EVENT_MANAGER" = "EVENT_MANAGER",
  actor = "o1",
) {
  const res = await api.inviteMember({ accountId, email, role }, as(actor));
  expect(res.userErrors).toEqual([]);
  return new URL(res.acceptLink!, "http://x").searchParams.get("token")!;
}

const rows = async (sql: string, params: unknown[] = []) =>
  (await pool.query<Record<string, unknown>>(sql, params)).rows;

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
  process.env.X_USER_ID_SIGNING_KEY = KEY;

  pool = new Pool({ connectionString: databaseUrl });
  const dir = path.join(__dirname, "../../migrations");
  for (const file of fs.readdirSync(dir).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), "utf-8"));
  }

  const { AppModule } = (await import("../app.module.js")) as {
    AppModule: typeof UserServiceAppModule;
  };
  const { AccountsResolver } = (await import("./accounts.resolver.js")) as {
    AccountsResolver: typeof AccountsResolverType;
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  api = moduleRef.get(AccountsResolver, { strict: false });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await pgContainer?.stop();
});

beforeEach(async () => {
  for (const t of [
    "venue_claims",
    "invitations",
    "memberships",
    "organizer_accounts",
    "audit_log",
  ]) {
    await pool.query(`DELETE FROM ${t}`);
  }
});

describe("accounts API (PostgreSQL)", () => {
  it("creating an organizer account makes the caller its owner and is audited", async () => {
    const res = await api.createOrganizerAccount(
      { name: "Acme", contactEmail: "team@acme.test" },
      as("u1"),
    );

    expect(res.userErrors).toEqual([]);
    const mine = await api.myAccounts(as("u1"));
    expect(mine.map((m) => [m.account.name, m.role])).toEqual([
      ["Acme", "OWNER"],
    ]);
    expect(await rows("SELECT actor_user_id, action FROM audit_log")).toEqual([
      { actor_user_id: "u1", action: "account.created" },
    ]);
  });

  it("an account needs a name", async () => {
    const res = await api.createOrganizerAccount({ name: "  " }, as("u1"));
    expect(res.account).toBeNull();
    expect(res.userErrors[0].code).toBe("INVALID");
  });

  it("accepting an invitation binds it to the signed-in user, once", async () => {
    const accountId = await newAccount();
    const token = await invite(accountId, "new@acme.test", "ADMIN");

    const first = await api.acceptInvitation(token, as("u2"));
    expect(first.userErrors).toEqual([]);
    expect(first.role).toBe("ADMIN");
    const [inv] = await rows("SELECT status, accepted_by FROM invitations");
    expect(inv).toEqual({ status: "ACCEPTED", accepted_by: "u2" });

    const second = await api.acceptInvitation(token, as("u3"));
    expect(second.userErrors[0].message).toMatch(/already been used/i);
    expect(
      await rows("SELECT 1 FROM memberships WHERE user_id = 'u3'"),
    ).toHaveLength(0);
  });

  it("two people racing on one invitation link: exactly one gets in", async () => {
    const accountId = await newAccount();
    const token = await invite(accountId, "x@acme.test");

    const results = await Promise.all([
      api.acceptInvitation(token, as("u2")),
      api.acceptInvitation(token, as("u3")),
    ]);

    expect(results.filter((r) => r.userErrors.length === 0)).toHaveLength(1);
    expect(
      await rows(
        "SELECT 1 FROM memberships WHERE resource_id = $1 AND role = 'EVENT_MANAGER'",
        [accountId],
      ),
    ).toHaveLength(1);
  });

  it("an expired invitation is rejected", async () => {
    const accountId = await newAccount();
    const token = await invite(accountId, "late@acme.test");
    await pool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 minute'",
    );

    const res = await api.acceptInvitation(token, as("u2"));

    expect(res.userErrors[0].message).toMatch(/expired/i);
    expect(
      await rows("SELECT 1 FROM memberships WHERE user_id = 'u2'"),
    ).toHaveLength(0);
  });

  it("an unknown invitation link is rejected without saying why", async () => {
    const res = await api.acceptInvitation("not-a-real-token", as("u2"));
    expect(res.userErrors[0].code).toBe("NOT_FOUND");
  });

  it("the invitation token is stored only as a hash", async () => {
    const accountId = await newAccount();
    const token = await invite(accountId, "h@acme.test");
    const [inv] = await rows("SELECT token_hash FROM invitations");
    expect(inv.token_hash).not.toContain(token);
    expect(inv.token_hash).toBe(
      crypto.createHash("sha256").update(token).digest("hex"),
    );
  });

  it("invitations cannot make someone an owner", async () => {
    const accountId = await newAccount();
    const res = await api.inviteMember(
      { accountId, email: "o@acme.test", role: "OWNER" as never },
      as("o1"),
    );
    expect(res.acceptLink).toBeNull();
    expect(res.userErrors[0].code).toBe("INVALID");
  });

  it("finance and door staff cannot invite", async () => {
    const accountId = await newAccount();
    const token = await invite(accountId, "f@acme.test", "DOOR_STAFF");
    await api.acceptInvitation(token, as("door"));

    const res = await api.inviteMember(
      { accountId, email: "z@acme.test", role: "DOOR_STAFF" },
      as("door"),
    );

    expect(res.userErrors[0].code).toBe("NOT_ALLOWED");
  });

  it("a suspended account cannot change its team", async () => {
    const accountId = await newAccount();
    await api.suspendAccount({ accountId, reason: "chargebacks" }, admin());

    const res = await api.inviteMember(
      { accountId, email: "z@acme.test", role: "ADMIN" },
      as("o1"),
    );

    expect(res.userErrors[0].code).toBe("NOT_ALLOWED");
  });

  it("an invitation to a suspended account cannot be accepted, and a huge token is just not valid", async () => {
    const accountId = await newAccount();
    const token = await invite(accountId, "late@acme.test", "DOOR_STAFF");
    await api.suspendAccount({ accountId, reason: "chargebacks" }, admin());

    const res = await api.acceptInvitation(token, as("late"));
    const huge = await api.acceptInvitation("x".repeat(5000), as("late"));

    expect(res.userErrors[0].code).toBe("NOT_ALLOWED");
    expect(
      await rows("SELECT 1 FROM memberships WHERE user_id = 'late'"),
    ).toEqual([]);
    expect(huge.userErrors[0].code).toBe("NOT_FOUND");
  });

  it("an admin cannot hand out ownership", async () => {
    const accountId = await newAccount();
    await api.acceptInvitation(
      await invite(accountId, "a@acme.test", "ADMIN"),
      as("adm"),
    );
    await api.acceptInvitation(
      await invite(accountId, "m@acme.test", "EVENT_MANAGER"),
      as("mgr"),
    );

    const res = await api.changeMemberRole(
      { accountId, userId: "mgr", role: "OWNER" },
      as("adm"),
    );

    expect(res.userErrors[0].code).toBe("NOT_ALLOWED");
  });

  it("the last owner can neither leave nor step down", async () => {
    const accountId = await newAccount();

    const removed = await api.removeMember(
      { accountId, userId: "o1" },
      as("o1"),
    );
    const demoted = await api.changeMemberRole(
      { accountId, userId: "o1", role: "ADMIN" },
      as("o1"),
    );

    expect(removed.removed).toBe(false);
    expect(removed.userErrors[0].message).toMatch(/at least one owner/i);
    expect(demoted.userErrors[0].message).toMatch(/at least one owner/i);
    expect(
      await rows("SELECT 1 FROM memberships WHERE role = 'OWNER'"),
    ).toHaveLength(1);
  });

  it("changing a role and removing a member are audited with the acting user", async () => {
    const accountId = await newAccount();
    await api.acceptInvitation(
      await invite(accountId, "m@acme.test", "EVENT_MANAGER"),
      as("mgr"),
    );

    await api.changeMemberRole(
      { accountId, userId: "mgr", role: "FINANCE" },
      as("o1"),
    );
    await api.removeMember({ accountId, userId: "mgr" }, as("o1"));

    const audit = await rows(
      "SELECT actor_user_id, actor_account_id, action, before, after FROM audit_log WHERE action LIKE 'membership.%' ORDER BY at, action",
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      "membership.removed",
      "membership.role_changed",
    ]);
    const changed = audit.find((a) => a.action === "membership.role_changed")!;
    expect(changed).toMatchObject({
      actor_user_id: "o1",
      actor_account_id: accountId,
      before: { role: "EVENT_MANAGER" },
      after: { role: "FINANCE" },
    });
  });

  it("door staff can be limited to events, and only door staff", async () => {
    const accountId = await newAccount();
    await api.acceptInvitation(
      await invite(accountId, "d@acme.test", "DOOR_STAFF"),
      as("door"),
    );
    await api.acceptInvitation(
      await invite(accountId, "m@acme.test", "EVENT_MANAGER"),
      as("mgr"),
    );

    const ok = await api.setDoorStaffEvents(
      { accountId, userId: "door", eventIds: [EVENT_1, EVENT_2] },
      as("o1"),
    );
    const notUuid = await api.setDoorStaffEvents(
      { accountId, userId: "door", eventIds: ["e1"] },
      as("o1"),
    );
    const bad = await api.setDoorStaffEvents(
      { accountId, userId: "mgr", eventIds: [EVENT_1] },
      as("o1"),
    );

    expect(ok.member?.eventIds.sort()).toEqual([EVENT_1, EVENT_2]);
    expect(bad.userErrors[0].code).toBe("INVALID");
    expect(notUuid.userErrors[0].code).toBe("INVALID");
    const members = await api.accountMembers(accountId, as("o1"));
    expect(members.find((m) => m.userId === "door")?.eventIds.sort()).toEqual([
      EVENT_1,
      EVENT_2,
    ]);
  });

  it("door staff see their own event limit in their accounts, since they may not read the team", async () => {
    const accountId = await newAccount();
    await api.acceptInvitation(
      await invite(accountId, "d@acme.test", "DOOR_STAFF"),
      as("door"),
    );
    await api.setDoorStaffEvents(
      { accountId, userId: "door", eventIds: [EVENT_1] },
      as("o1"),
    );

    const [door] = await api.myAccounts(as("door"));
    const [owner] = await api.myAccounts(as("o1"));

    expect(door).toMatchObject({ role: "DOOR_STAFF", eventIds: [EVENT_1] });
    expect(owner).toMatchObject({ role: "OWNER", eventIds: [] });
  });

  it("only team managers see the member list, and buyers see no account", async () => {
    const accountId = await newAccount();

    await expect(api.accountMembers(accountId, as("stranger"))).rejects.toThrow(
      /not allowed/i,
    );
    expect(await api.account(accountId, as("stranger"))).toBeNull();
    expect((await api.account(accountId, as("o1")))?.name).toBe("Acme");
  });

  it("myInvitations lists what I sent, with expired ones marked", async () => {
    const accountId = await newAccount();
    await invite(accountId, "a@acme.test");
    await invite(accountId, "b@acme.test");
    await pool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 day' WHERE email = 'b@acme.test'",
    );

    const mine = await api.myInvitations(as("o1"));

    expect(mine.map((i) => [i.email, i.status]).sort()).toEqual([
      ["a@acme.test", "PENDING"],
      ["b@acme.test", "EXPIRED"],
    ]);
    expect(await api.myInvitations(as("someone"))).toEqual([]);
  });

  it("approving a venue claim creates a venue manager membership", async () => {
    const claim = await api.submitVenueClaim(
      { venueId: "venue-1", evidenceText: "I run it" },
      as("claimant"),
    );
    expect(claim.userErrors).toEqual([]);

    const res = await api.decideVenueClaim(
      { claimId: claim.claim!.id, decision: "APPROVE", reason: "docs ok" },
      admin(),
    );

    expect(res.userErrors).toEqual([]);
    expect(res.claim?.status).toBe("APPROVED");
    expect(
      await rows(
        "SELECT user_id, role FROM memberships WHERE resource_type = 'VENUE' AND resource_id = 'venue-1'",
      ),
    ).toEqual([{ user_id: "claimant", role: "VENUE_MANAGER" }]);
    const [row] = await rows("SELECT decided_by, reason FROM venue_claims");
    expect(row).toEqual({ decided_by: "admin", reason: "docs ok" });
    expect(
      (await rows("SELECT action FROM audit_log")).map((a) => a.action),
    ).toContain("venue_claim.decided");
  });

  it("rejecting a venue claim creates no membership and a claim is decided once", async () => {
    const claim = await api.submitVenueClaim(
      { venueId: "venue-1" },
      as("claimant"),
    );
    const id = claim.claim!.id;

    const rejected = await api.decideVenueClaim(
      { claimId: id, decision: "REJECT", reason: "no proof" },
      admin(),
    );
    const again = await api.decideVenueClaim(
      { claimId: id, decision: "APPROVE", reason: "changed my mind" },
      admin(),
    );

    expect(rejected.claim?.status).toBe("REJECTED");
    expect(again.userErrors[0].code).toBe("CONFLICT");
    expect(
      await rows("SELECT 1 FROM memberships WHERE resource_type = 'VENUE'"),
    ).toHaveLength(0);
  });

  it("deciding a claim needs a reason", async () => {
    const claim = await api.submitVenueClaim({ venueId: "v" }, as("c"));
    const res = await api.decideVenueClaim(
      { claimId: claim.claim!.id, decision: "APPROVE", reason: " " },
      admin(),
    );
    expect(res.userErrors[0].code).toBe("INVALID");
  });

  it("a user cannot file the same pending claim twice", async () => {
    await api.submitVenueClaim({ venueId: "v" }, as("c"));
    const dup = await api.submitVenueClaim({ venueId: "v" }, as("c"));
    expect(dup.userErrors[0].code).toBe("CONFLICT");
  });

  it("a claim on behalf of an account needs membership in that account", async () => {
    const accountId = await newAccount("o1");
    const res = await api.submitVenueClaim(
      { venueId: "v", accountId },
      as("outsider"),
    );
    expect(res.userErrors[0].code).toBe("NOT_ALLOWED");
  });

  describe("only platform admins decide claims or suspend", () => {
    it("rejects an ordinary user, a support agent and an unsigned admin header", async () => {
      const accountId = await newAccount();
      const claim = await api.submitVenueClaim({ venueId: "v" }, as("c"));
      const forged = {
        req: {
          headers: { "x-user-id": "evil", "x-user-roles": "platform_admin" },
        },
      } as never;
      const wrongSig = {
        req: {
          headers: {
            "x-user-id": "evil",
            "x-user-roles": "platform_admin",
            "x-user-roles-sig": "AAAA",
          },
        },
      } as never;

      for (const ctx of [
        as("o1"),
        as("support", "platform_support"),
        forged,
        wrongSig,
      ]) {
        const decide = await api.decideVenueClaim(
          { claimId: claim.claim!.id, decision: "APPROVE", reason: "x" },
          ctx,
        );
        const suspend = await api.suspendAccount(
          { accountId, reason: "x" },
          ctx,
        );
        expect(decide.userErrors[0].code).toBe("NOT_ALLOWED");
        expect(suspend.userErrors[0].code).toBe("NOT_ALLOWED");
      }
      expect(
        await rows("SELECT status FROM organizer_accounts WHERE id = $1", [
          accountId,
        ]),
      ).toEqual([{ status: "ACTIVE" }]);
    });

    it("lets a verified platform admin suspend, with the reason audited", async () => {
      const accountId = await newAccount();

      const res = await api.suspendAccount(
        { accountId, reason: "chargebacks" },
        admin(),
      );

      expect(res.account?.status).toBe("SUSPENDED");
      const [a] = await rows(
        "SELECT actor_user_id, reason, before, after FROM audit_log WHERE action = 'account.suspended'",
      );
      expect(a).toMatchObject({
        actor_user_id: "admin",
        reason: "chargebacks",
        before: { status: "ACTIVE" },
        after: { status: "SUSPENDED" },
      });
    });
  });

  it("every mutation reports a missing identity as an error, not a crash", async () => {
    const anon = { req: { headers: {} } } as never;
    await expect(api.myAccounts(anon)).rejects.toThrow(/X-User-Id/);
  });

  it("an unexpected failure is reported without internal text", async () => {
    const accountId = await newAccount();
    await pool.query("ALTER TABLE invitations RENAME TO invitations_gone");
    try {
      const res = await api.inviteMember(
        { accountId, email: "a@acme.test", role: "ADMIN" },
        as("o1"),
      );
      expect(res.userErrors[0]).toMatchObject({
        code: "INTERNAL",
        message: "Something went wrong. Try again.",
      });
    } finally {
      await pool.query("ALTER TABLE invitations_gone RENAME TO invitations");
    }
  });

  it("is served over GraphQL for a signed-in caller and refused when the identity signature is wrong", async () => {
    await app.listen(0);
    const url = `${await app.getUrl()}/graphql`;
    const minute = Math.floor(Date.now() / 1000 / 60);
    const sig = crypto
      .createHmac("sha256", KEY)
      .update(`gql-user|${minute}`)
      .digest("base64");
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "gql-user",
          ...headers,
        },
        body: JSON.stringify({
          query:
            'mutation { createOrganizerAccount(input: { name: "Via HTTP" }) { account { name status } userErrors { code } } }',
        }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

    const ok = await post({ "x-user-id-sig": sig });
    const bad = await post({ "x-user-id-sig": "forged" });

    expect(ok.data).toEqual({
      createOrganizerAccount: {
        account: { name: "Via HTTP", status: "ACTIVE" },
        userErrors: [],
      },
    });
    expect(bad.errors).toBeDefined();
    expect(
      await rows("SELECT 1 FROM organizer_accounts WHERE name = 'Via HTTP'"),
    ).toHaveLength(1);
  });
});
