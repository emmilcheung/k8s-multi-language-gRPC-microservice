import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
const redirectMock = vi.fn();
const authHeadersMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8080",
  authHeaders: () => authHeadersMock(),
}));

import { cancelOrder, createOrder, submitPayment } from "@/app/actions/orders";

describe("order server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authHeadersMock.mockResolvedValue({ "Content-Type": "application/json" });
    process.env.STRIPE_TEST_TOKEN = "pm_card_visa";
  });

  it("createOrder returns upstream failure message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: { message: "Ticket reserved" } }),
      })
    );

    const result = await createOrder("ticket-1", {}, new FormData());
    expect(result).toEqual({ error: "Ticket reserved" });
  });

  it("createOrder revalidates and redirects on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "order-1" }),
      })
    );

    await createOrder("ticket-1", {}, new FormData());
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders");
    expect(redirectMock).toHaveBeenCalledWith("/orders/order-1");
  });

  it("cancelOrder redirects to /orders on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      })
    );

    await cancelOrder("order-2", {}, new FormData());
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders");
    expect(redirectMock).toHaveBeenCalledWith("/orders");
  });

  it("submitPayment converts dollars to cents", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal("fetch", fetchMock);

    await submitPayment("order-3", 12.34, {}, new FormData());

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as { amount: number; token: string };
    expect(body.amount).toBe(1234);
    expect(body.token).toBe("pm_card_visa");
    expect(redirectMock).toHaveBeenCalledWith("/orders/order-3");
  });
});
