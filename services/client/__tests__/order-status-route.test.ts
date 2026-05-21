import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api";

const executeQueryMock = vi.fn();

vi.mock("@/lib/graphql/execute", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

vi.mock("@/lib/tracing", () => ({
  traceHeaders: () => ({}),
  traceResponseHeaders: () => ({ "x-trace-id": "test-trace" }),
}));

import { GET } from "@/app/api/orders/[orderId]/status/route";

describe("order status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns order status when GraphQL succeeds", async () => {
    executeQueryMock.mockResolvedValue({
      order: {
        id: "order-1",
        userId: "user-1",
        status: "COMPLETE",
        expiresAt: "2099-12-31T23:59:59.000Z",
        createdAt: "2099-12-31T22:59:59.000Z",
        ticket: { id: "ticket-1", title: "Test Ticket", price: "25.00" },
        quantity: 1,
      },
    });

    const expectedOrder = {
      id: "order-1",
      userId: "user-1",
      status: "complete",
      expiresAt: "2099-12-31T23:59:59.000Z",
      ticket: { id: "ticket-1", title: "Test Ticket", price: "25.00" },
      quantity: 1,
      version: 0,
    };

    const request = new NextRequest("http://localhost/api/orders/order-1/status", {
      method: "GET",
    });

    const response = await GET(request, { params: Promise.resolve({ orderId: "order-1" }) });

    expect(response.status).toBe(200);
    const body = await response.json() as { order?: object };
    expect(body.order).toEqual(expectedOrder);
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

  it("returns GraphQL error when the order query fails", async () => {
    executeQueryMock.mockRejectedValue(
      new ApiError(404, "Order not found", {
        error: { code: "NOT_FOUND", message: "Order not found" },
      }),
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
