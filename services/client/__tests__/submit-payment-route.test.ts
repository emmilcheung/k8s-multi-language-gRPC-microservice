import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const revalidatePathMock = vi.fn();
const authHeadersMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8000",
  authHeaders: (...args: unknown[]) => authHeadersMock(...args),
}));

vi.mock("@/lib/tracing", () => ({
  traceResponseHeaders: () => ({ "x-trace-id": "test-trace" }),
}));

import { POST } from "@/app/api/submit-payment/route";

describe("submit-payment route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authHeadersMock.mockResolvedValue({ "Content-Type": "application/json" });
  });

  it("returns 201 when upstream succeeds with an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const request = new NextRequest("http://localhost/api/submit-payment", {
      method: "POST",
      body: JSON.stringify({ orderId: "order-1", paymentMethodId: "pm_mock_success" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({});
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders/order-1");
  });

  it("returns upstream error payload when payment is declined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "PAYMENT_FAILED", message: "Mock payment declined" } }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );

    const request = new NextRequest("http://localhost/api/submit-payment", {
      method: "POST",
      body: JSON.stringify({ orderId: "order-2", paymentMethodId: "pm_mock_declined" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "PAYMENT_FAILED", message: "Mock payment declined" },
    });
  });
});