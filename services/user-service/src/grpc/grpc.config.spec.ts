import { describe, expect, it, vi } from "vitest";

// Importing the app module validates the process environment once.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db";
});

import { envSchema } from "../app.module";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

const issues = (env: Record<string, string>) => {
  const result = envSchema.safeParse({ ...base, ...env });
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("PUBLIC_WEB_URL config", () => {
  it("accepts only http(s) origins, since it becomes the host of invitation links", () => {
    expect(issues({ PUBLIC_WEB_URL: "https://shop.example.com" })).toEqual([]);
    expect(issues({ PUBLIC_WEB_URL: "javascript://x/%0Aalert(1)" })).toContain(
      "PUBLIC_WEB_URL",
    );
    expect(issues({ PUBLIC_WEB_URL: "ftp://shop.example.com" })).toContain(
      "PUBLIC_WEB_URL",
    );
  });
});

describe("GRPC_PORT config", () => {
  it("refuses to start when GRPC_PORT is not a port number", () => {
    expect(issues({ GRPC_PORT: "not-a-port" })).toContain("GRPC_PORT");
    expect(issues({ GRPC_PORT: "70000" })).toContain("GRPC_PORT");
  });

  it("refuses to start when the gRPC and HTTP servers would share a port", () => {
    expect(issues({ PORT: "3004", GRPC_PORT: "3004" })).toContain("GRPC_PORT");
  });

  it("starts with a valid GRPC_PORT, and defaults to the documented port", () => {
    expect(issues({ GRPC_PORT: "50053" })).toEqual([]);
    expect(envSchema.parse(base).GRPC_PORT).toBe(50053);
  });
});
