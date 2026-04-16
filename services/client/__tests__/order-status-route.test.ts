import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const authHeadersMock = vi.fn();

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8000",
  authHeaders: (...args: unknown[]) => authHeadersMock(...args),
}));

vi.mock("@/lib/tracing", () => ({
  traceResponseHeaders: () => ({ "x-trace-id": "test-trace" }),
}));

import { GET } from "@/app/api/orders/[orderId]/status/route";

describe("order status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authHeadersMock.mockResolvedValue({ "Content-Type": "application/json" });
  });

  it("returns order status when upstream succeeds", async () => {
    const mockOrder = {
      id: "order-1",
      userId: "user-1",
      status: "complete",
      expiresAt: "2099-12-31T23:59:59.000Z",
      ticket: { id: "ticket-1", title: "Test Ticket", price: "25.00" },
      quantity: 1,
      version: 1,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockOrder), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const request = new NextRequest("http://localhost/api/orders/order-1/status", {
      method: "GET",
    });

    const response = await GET(request, { params: Promise.resolve({ orderId: "order-1" }) });

    expect(response.status).toBe(200);
    const body = await response.json() as { order?: object };
    expect(body.order).toEqual(mockOrder);
  });

  it("returns error when orderId is missing", async () => {
    const request = new NextRequest("http://localhost/api/orders/order-1/status", {
      method: "GET",
    });

    const response = await GET(request, { params: Promise.resolve({ orderId: "" }) });

    expect(response.status).toBe(400);
    const body = await response.json() as { error?: { code: string } };
    expect(body.error?.code).toBe("INVALID_INPUT");
  });

  it("returns upstream error when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "Order not found" } }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );

    const request = new NextRequest("http://localhost/api/orders/order-1/status", {
      method: "GET",
    });

    const response = await GET(request, { params: Promise.resolve({ orderId: "order-1" }) });

    expect(response.status).toBe(404);
    const body = await response.json() as { error?: { code: string } };
    expect(body.error?.code).toBe("NOT_FOUND");
  });
});
