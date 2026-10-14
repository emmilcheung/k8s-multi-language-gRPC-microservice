import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import type { AppModule as UserServiceAppModule } from "../app.module";
import type { attachGrpcServer as AttachGrpcServer } from "./grpc.setup";
import type { AccountsService as AccountsServiceType } from "../modules/accounts/accounts.service";

const REPO_PROTO = path.join(__dirname, "../../../../proto");

let pgContainer: StartedPostgreSqlContainer;
let pool: Pool;
let app: INestApplication;
let accounts: AccountsServiceType;
let accountsClient: grpc.Client;
let healthClient: grpc.Client;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function loadClient(file: string, service: string[], address: string) {
  const def = protoLoader.loadSync(file, {
    keepCase: true,
    enums: String,
    defaults: true,
    includeDirs: [REPO_PROTO, path.dirname(file)],
  });
  let node: unknown = grpc.loadPackageDefinition(def);
  for (const part of service) node = (node as Record<string, unknown>)[part];
  const Ctor = node as new (
    a: string,
    c: grpc.ChannelCredentials,
  ) => grpc.Client;
  return new Ctor(address, grpc.credentials.createInsecure());
}

function call<T>(
  client: grpc.Client,
  method: string,
  request: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    (
      client as unknown as Record<
        string,
        (r: unknown, cb: (e: grpc.ServiceError | null, res: T) => void) => void
      >
    )[method](request, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("users_test")
    .withUsername("users_user")
    .withPassword("users_pass")
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  const grpcPort = await freePort();
  process.env.DATABASE_URL = databaseUrl;
  process.env.DB_POOL_MAX = "10";
  process.env.NODE_ENV = "test";
  process.env.GRPC_PORT = String(grpcPort);

  pool = new Pool({ connectionString: databaseUrl });
  const migrationsDir = path.join(__dirname, "../../migrations");
  for (const file of fs.readdirSync(migrationsDir).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), "utf-8"));
  }

  const { AppModule } = (await import("../app.module.js")) as {
    AppModule: typeof UserServiceAppModule;
  };
  const { attachGrpcServer } = (await import("./grpc.setup.js")) as {
    attachGrpcServer: typeof AttachGrpcServer;
  };
  const { AccountsService } =
    (await import("../modules/accounts/accounts.service.js")) as {
      AccountsService: typeof AccountsServiceType;
    };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication();
  attachGrpcServer(app);
  await app.init();
  await app.startAllMicroservices();
  accounts = moduleRef.get(AccountsService, { strict: false });

  const address = `127.0.0.1:${grpcPort}`;
  accountsClient = loadClient(
    path.join(REPO_PROTO, "accounts/v1/accounts.proto"),
    ["acme", "accounts", "v1", "AccountsService"],
    address,
  );
  healthClient = loadClient(
    path.join(__dirname, "health.proto"),
    ["grpc", "health", "v1", "Health"],
    address,
  );
}, 90_000);

afterAll(async () => {
  accountsClient?.close();
  healthClient?.close();
  await app?.close();
  await pool?.end();
  await pgContainer?.stop();
});

beforeEach(async () => {
  await pool.query("DELETE FROM memberships");
  await pool.query("DELETE FROM organizer_accounts");
});

describe("accounts gRPC server (PostgreSQL)", () => {
  it("answers the standard gRPC health check on GRPC_PORT", async () => {
    const res = await call<{ status: string }>(healthClient, "Check", {
      service: "",
    });
    expect(res.status).toBe("SERVING");
  });

  it("reports health for the accounts service by name and NOT_FOUND for others", async () => {
    const res = await call<{ status: string }>(healthClient, "Check", {
      service: "acme.accounts.v1.AccountsService",
    });
    expect(res.status).toBe("SERVING");
    await expect(
      call(healthClient, "Check", { service: "no.such.Service" }),
    ).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });

  it("CheckPermission over the wire allows a team member and denies a stranger with the reason", async () => {
    const account = await accounts.createAccount({
      name: "Acme",
      createdBy: "owner-1",
    });
    const ask = (userId: string, platformRoles: string[] = []) =>
      call<{ allowed: boolean; reason_code: string }>(
        accountsClient,
        "CheckPermission",
        {
          user_id: userId,
          platform_roles: platformRoles,
          permission: "event.publish",
          account_id: account.id,
        },
      );

    expect(await ask("owner-1")).toEqual({
      allowed: true,
      reason_code: "REASON_CODE_UNSPECIFIED",
    });
    expect(await ask("stranger")).toEqual({
      allowed: false,
      reason_code: "REASON_CODE_NOT_MEMBER",
    });
    expect((await ask("stranger", ["platform_admin"])).allowed).toBe(true);
  });

  it("CheckPermission rejects a permission name it does not know instead of denying quietly", async () => {
    await expect(
      call(accountsClient, "CheckPermission", {
        user_id: "u1",
        permission: "event.destroy",
      }),
    ).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });

  it("EnsurePersonalAccount returns the same account every time and ListMyAccounts shows it", async () => {
    const first = await call<{ account_id: string }>(
      accountsClient,
      "EnsurePersonalAccount",
      { user_id: "u1", display_name: "Una" },
    );
    const second = await call<{ account_id: string }>(
      accountsClient,
      "EnsurePersonalAccount",
      { user_id: "u1", display_name: "Other" },
    );
    expect(second.account_id).toBe(first.account_id);

    const mine = await call<{
      accounts: {
        role: string;
        account: { id: string; name: string; status: string };
      }[];
    }>(accountsClient, "ListMyAccounts", { user_id: "u1" });
    expect(mine.accounts).toEqual([
      {
        role: "OWNER",
        account: {
          id: first.account_id,
          name: "Una",
          status: "ACCOUNT_STATUS_ACTIVE",
        },
      },
    ]);
  });

  it("EnsureVenueManager lets the venue's creator keep editing it, and repeating it changes nothing", async () => {
    const edit = (user: string) =>
      call<{ allowed: boolean }>(accountsClient, "CheckPermission", {
        user_id: user,
        permission: "venue.edit_profile",
        venue_id: "venue-1",
      });
    expect((await edit("creator")).allowed).toBe(false);

    await call(accountsClient, "EnsureVenueManager", {
      user_id: "creator",
      venue_id: "venue-1",
    });
    await call(accountsClient, "EnsureVenueManager", {
      user_id: "creator",
      venue_id: "venue-1",
    });

    expect((await edit("creator")).allowed).toBe(true);
    expect((await edit("someone-else")).allowed).toBe(false);
  });

  it("GetAccount returns display data, and NOT_FOUND for an account that does not exist", async () => {
    const account = await accounts.createAccount({
      name: "Acme",
      createdBy: "o1",
    });
    const res = await call<{ account: { id: string; name: string } }>(
      accountsClient,
      "GetAccount",
      { account_id: account.id },
    );
    expect(res.account).toMatchObject({ id: account.id, name: "Acme" });

    await expect(
      call(accountsClient, "GetAccount", {
        account_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });
});
