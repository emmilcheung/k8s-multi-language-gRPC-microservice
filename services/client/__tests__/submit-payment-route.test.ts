import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const revalidatePathMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/tracing", () => ({
  traceHeaders: () => ({}),
  traceResponseHeaders: () => ({ "x-trace-id": "test-trace" }),
}));

import { POST } from "@/app/api/submit-payment/route";

describe("submit-payment route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns payment-service success for a new-card payment", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue({
        payment: { id: "pay-1", orderId: "order-1", status: "completed" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("http://localhost/api/submit-payment", {
      method: "POST",
      body: JSON.stringify({ orderId: "order-1", paymentMethodId: "pm_mock_success" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      payment: { id: "pay-1", orderId: "order-1", status: "completed" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/payments"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orderId: "order-1", token: "pm_mock_success" }),
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders/order-1");
  });

  it("supports saved payment method IDs through payment-service REST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue({
        payment: { id: "pay-2", orderId: "order-2", status: "completed" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new NextRequest("http://localhost/api/submit-payment", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-2",
        savedPaymentMethodId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      headers: { "Content-Type": "application/json", Cookie: "token=jwt" },
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      payment: { id: "pay-2", orderId: "order-2", status: "completed" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/payments"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Cookie: "token=jwt",
        }),
        body: JSON.stringify({
          orderId: "order-2",
          savedPaymentMethodId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      }),
    );
  });

  it("returns payment-service error payload when payment is declined", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({
        error: { code: "PAYMENT_FAILED", message: "Mock payment declined" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

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