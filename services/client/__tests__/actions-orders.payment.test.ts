import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMutationMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/graphql/execute", () => ({
  executeMutation: (...args: unknown[]) => executeMutationMock(...args),
}));

import { submitPayment } from "@/app/actions/orders";

describe("submitPayment action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses paymentMethodId for new-card GraphQL CreatePayment calls", async () => {
    executeMutationMock.mockResolvedValue({
      createPayment: { id: "pay-1", orderId: "order-1" },
    });
    const formData = new FormData();
    formData.set("paymentMethodId", "pm_card_visa");

    const result = await submitPayment("order-1", {}, formData);

    expect(result).toEqual({});
    expect(executeMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      { input: { orderId: "order-1", token: "pm_card_visa" } },
      { timeoutMs: 20_000 }
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders/order-1");
  });

  it("uses savedPaymentMethodId for saved-card GraphQL CreatePayment calls", async () => {
    executeMutationMock.mockResolvedValue({
      createPayment: { id: "pay-2", orderId: "order-2" },
    });
    const formData = new FormData();
    formData.set("savedPaymentMethodId", "pm-saved-1");

    const result = await submitPayment("order-2", {}, formData);

    expect(result).toEqual({});
    expect(executeMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      { input: { orderId: "order-2", savedPaymentMethodId: "pm-saved-1" } },
      { timeoutMs: 20_000 }
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders/order-2");
  });
});
