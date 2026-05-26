import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const executeMutationMock = vi.fn();

vi.mock("@/lib/graphql/execute", () => ({
  executeMutation: (...args: unknown[]) => executeMutationMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  authHeaders: vi.fn().mockResolvedValue({ authorization: "Bearer test" }),
  base: () => "http://localhost:8000",
}));

vi.mock("@/lib/tracing", () => ({
  traceResponseHeaders: () => ({ "x-trace-id": "test-trace" }),
}));

import { POST as deactivatePlan } from "@/app/api/seating-plans/[planId]/deactivate/route";

describe("seating plan status routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: "inactive" }),
      }),
    );
  });

  it("uses an extended GraphQL timeout when deactivating a plan", async () => {
    executeMutationMock.mockResolvedValue({
      deactivateSeatingPlan: { id: "plan-1", status: "inactive", assignmentMode: "manual" },
    });

    const request = new NextRequest("http://localhost/api/seating-plans/plan-1/deactivate", {
      method: "POST",
      headers: {
        cookie: "token=test-token; refreshToken=test-refresh",
      },
    });

    const response = await deactivatePlan(request, { params: Promise.resolve({ planId: "plan-1" }) });

    expect(response.status).toBe(200);
    expect(executeMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      { id: "plan-1" },
      expect.objectContaining({
        cookie: "token=test-token; refreshToken=test-refresh",
        timeoutMs: 15_000,
      }),
    );
  });
});
