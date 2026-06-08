import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";

const revalidatePathMock = vi.fn();
const redirectMock = vi.fn();
const executeMutationMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
}));

vi.mock("@/lib/graphql/execute", () => ({
  executeMutation: (...args: unknown[]) => executeMutationMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8080",
  authHeaders: vi.fn().mockResolvedValue({ "Content-Type": "application/json" }),
}));

import {
  cancelOrder,
  createAutoAssignSeatedOrder,
  createManualSeatedOrder,
  createOrder,
  initiateTransfer,
  requestRefund,
  submitPayment,
} from "@/app/actions/orders";

describe("order server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_TEST_TOKEN = "pm_card_visa";
  });

  it("createOrder returns GraphQL failure message", async () => {
    executeMutationMock.mockRejectedValue(new ApiError(409, "Ticket reserved"));

    const result = await createOrder("ticket-1", {}, new FormData());
    expect(result).toEqual({ error: "Ticket reserved" });
  });

  it("createOrder revalidates and redirects on GraphQL success", async () => {
    executeMutationMock.mockResolvedValue({
      createOrder: { id: "order-1" },
    });

    await createOrder("ticket-1", {}, new FormData());
    expect(executeMutationMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders");
    expect(redirectMock).toHaveBeenCalledWith("/orders/order-1");
  });

  it("createOrder rethrows redirect after GraphQL success", async () => {
    const redirectError = new Error("NEXT_REDIRECT");
    executeMutationMock.mockResolvedValue({
      createOrder: { id: "order-1" },
    });
    redirectMock.mockImplementationOnce(() => {
      throw redirectError;
    });

    await expect(createOrder("ticket-1", {}, new FormData())).rejects.toBe(redirectError);
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders");
    expect(redirectMock).toHaveBeenCalledWith("/orders/order-1");
  });

  it("cancelOrder redirects to /orders on GraphQL success", async () => {
    executeMutationMock.mockResolvedValue({
      cancelOrder: { id: "order-2" },
    });

    await cancelOrder("order-2", {}, new FormData());
    expect(executeMutationMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith("/orders");
    expect(redirectMock).toHaveBeenCalledWith("/orders");
  });

  it("submitPayment uses paymentMethodId from formData in GraphQL payment mutation", async () => {
    executeMutationMock.mockResolvedValue({
      createPayment: { id: "pay-1", orderId: "order-3" },
    });
    const formData = new FormData();
    formData.set("paymentMethodId", "pm_new_123");

    const result = await submitPayment("order-3", {}, formData);

    expect(result).toEqual({});
    expect(executeMutationMock).toHaveBeenCalledWith(expect.anything(), {
      input: { orderId: "order-3", token: "pm_new_123" },
    });
  });

  it("submitPayment uses savedPaymentMethodId from formData in GraphQL payment mutation", async () => {
    executeMutationMock.mockResolvedValue({
      createPayment: { id: "pay-2", orderId: "order-4" },
    });
    const formData = new FormData();
    formData.set("savedPaymentMethodId", "saved-pm-456");

    const result = await submitPayment("order-4", {}, formData);

    expect(result).toEqual({});
    expect(executeMutationMock).toHaveBeenCalledWith(expect.anything(), {
      input: { orderId: "order-4", savedPaymentMethodId: "saved-pm-456" },
    });
  });

  it("createManualSeatedOrder uses the GraphQL seated-order mutation", async () => {
    executeMutationMock.mockResolvedValue({
      createSeatedOrder: { id: "order-4" },
    });
    const formData = new FormData();
    formData.set("seatIds", JSON.stringify(["seat-a", "seat-b"]));

    await createManualSeatedOrder("ticket-1", "plan-1", {}, formData);

    expect(executeMutationMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/orders/order-4");
  });

  it("createAutoAssignSeatedOrder uses the GraphQL seated-order mutation", async () => {
    executeMutationMock.mockResolvedValue({
      createSeatedOrder: { id: "order-5" },
    });
    const formData = new FormData();
    formData.set("sectionId", "section-a");
    formData.set("quantity", "3");

    await createAutoAssignSeatedOrder("ticket-1", "plan-1", {}, formData);

    expect(executeMutationMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/orders/order-5");
  });

  it("initiateTransfer requires recipient email", async () => {
    const formData = new FormData();
    formData.set("credentialId", "cred-9");
    const result = await initiateTransfer("order-9", {}, formData);
    expect(result).toEqual({ error: "Recipient email is required." });
  });

  it("initiateTransfer calls GraphQL transfer mutation", async () => {
    executeMutationMock.mockResolvedValue({
      transferAdmissionCredential: { pendingTransferId: "xfer-1" },
    });
    const formData = new FormData();
    formData.set("credentialId", "cred-1");
    formData.set("recipient", "friend@example.com");

    const result = await initiateTransfer("order-9", {}, formData);
    expect(result).toEqual({ success: "Transfer request sent." });
    expect(executeMutationMock).toHaveBeenCalledWith(expect.anything(), {
      input: { credentialId: "cred-1", recipientEmail: "friend@example.com" },
    });
  });

  it("requestRefund requires reason", async () => {
    const result = await requestRefund("order-9", {}, new FormData());
    expect(result).toEqual({ error: "Refund reason is required." });
  });

  it("requestRefund calls GraphQL refund mutation", async () => {
    executeMutationMock.mockResolvedValue({
      requestRefund: { refundId: "refund-1", status: "REQUESTED" },
    });
    const formData = new FormData();
    formData.set("reason", "Unable to attend");

    const result = await requestRefund("order-9", {}, formData);
    expect(result).toEqual({ success: "Refund request submitted." });
    expect(executeMutationMock).toHaveBeenCalledWith(expect.anything(), {
      input: { orderId: "order-9", reason: "Unable to attend" },
    });
  });
});
