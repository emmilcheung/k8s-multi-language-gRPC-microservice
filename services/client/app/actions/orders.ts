"use server";
// app/actions/orders.ts — Server Actions for order mutations.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { executeMutation } from "@/lib/graphql/execute";
import {
  CancelOrderDocument,
  CreateOrderDocument,
  CreatePaymentDocument,
  CreateSeatedOrderDocument,
  RequestRefundDocument,
  TransferAdmissionCredentialDocument,
} from "@/lib/graphql/generated";

export interface OrderState {
  error?: string;
  success?: string;
}

function isRedirectError(error: unknown): error is Error & { digest?: string } {
  if (!(error instanceof Error)) return false;
  if (error.message === "NEXT_REDIRECT") return true;
  const redirectError = error as Error & { digest?: string };
  return typeof redirectError.digest === "string" && redirectError.digest.startsWith("NEXT_REDIRECT");
}

export async function createOrder(
  ticketId: string,
  _prev: OrderState,
  formData: FormData
): Promise<OrderState> {
  const quantityRaw = formData.get("quantity");
  const quantity = quantityRaw ? parseInt(String(quantityRaw), 10) : 1;
  if (isNaN(quantity) || quantity < 1) {
    return { error: "Quantity must be at least 1." };
  }

  try {
    const data = await executeMutation(CreateOrderDocument, {
      input: { ticketId, quantity },
    });
    revalidatePath("/orders");
    redirect(`/orders/${data.createOrder.id}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to create order." };
  }
}

export async function cancelOrder(
  orderId: string,
  prev: OrderState,
  formData: FormData
): Promise<OrderState> {
  void prev;
  void formData;

  try {
    await executeMutation(CancelOrderDocument, { id: orderId });
    revalidatePath("/orders");
    redirect("/orders");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to cancel order." };
  }
}

export async function submitPayment(
  orderId: string,
  prev: OrderState,
  formData: FormData
): Promise<OrderState> {
  void prev;
  const paymentMethodId = String(formData.get("paymentMethodId") ?? "").trim();
  const savedPaymentMethodId = String(formData.get("savedPaymentMethodId") ?? "").trim();
  if (!paymentMethodId && !savedPaymentMethodId) {
    return { error: "Payment method is required." };
  }

  try {
    const input = savedPaymentMethodId
      ? { orderId, savedPaymentMethodId }
      : { orderId, token: paymentMethodId };
    await executeMutation(CreatePaymentDocument, {
      input,
    });
    revalidatePath(`/orders/${orderId}`);
    return {};
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Payment failed." };
  }
}

// ─── Seated order actions ─────────────────────────────────────────────────────

export interface SeatedOrderState {
  error?: string;
  /** Set when the order was created but a redirect is needed (client-side navigation). */
  orderId?: string;
}

/**
 * Creates a seated order for manually-selected seats.
 * Calls the GraphQL createSeatedOrder mutation with explicit seatIds.
 */
export async function createManualSeatedOrder(
  ticketId: string,
  planId: string,
  _prev: SeatedOrderState,
  formData: FormData
): Promise<SeatedOrderState> {
  const rawSeatIds = formData.get("seatIds");
  if (!rawSeatIds) return { error: "No seats selected." };

  let seatIds: string[];
  try {
    seatIds = JSON.parse(String(rawSeatIds)) as string[];
  } catch {
    return { error: "Invalid seat selection." };
  }
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    return { error: "At least one seat must be selected." };
  }

  try {
    const data = await executeMutation(CreateSeatedOrderDocument, {
      input: {
        ticketId,
        planId,
        seatIds,
        quantity: seatIds.length,
      },
    });
    revalidatePath("/orders");
    redirect(`/orders/${data.createSeatedOrder.id}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to create seated order." };
  }
}

/**
 * Creates a seated order using auto-assign (best-available).
 * Calls the GraphQL createSeatedOrder mutation with sectionId + quantity.
 */
export async function createAutoAssignSeatedOrder(
  ticketId: string,
  planId: string,
  _prev: SeatedOrderState,
  formData: FormData
): Promise<SeatedOrderState> {
  const sectionId = formData.get("sectionId") as string | null;
  const quantityRaw = formData.get("quantity");
  const quantity = quantityRaw ? parseInt(String(quantityRaw), 10) : 1;

  if (!sectionId) return { error: "Section is required for auto-assign." };
  if (isNaN(quantity) || quantity < 1) return { error: "Quantity must be at least 1." };

  try {
    const data = await executeMutation(CreateSeatedOrderDocument, {
      input: { ticketId, planId, sectionId, quantity },
    });
    revalidatePath("/orders");
    redirect(`/orders/${data.createSeatedOrder.id}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to create auto-assign order." };
  }
}

export async function initiateTransfer(
  orderId: string,
  _prev: OrderState,
  formData: FormData
): Promise<OrderState> {
  const credentialId = String(formData.get("credentialId") ?? "").trim();
  const recipient = String(formData.get("recipient") ?? "").trim();
  if (!credentialId) {
    return { error: "Pass credential is required." };
  }
  if (!recipient) {
    return { error: "Recipient email is required." };
  }
  try {
    await executeMutation(TransferAdmissionCredentialDocument, {
      input: {
        credentialId,
        recipientEmail: recipient,
      },
    });
    revalidatePath(`/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}/transfer`);
    return { success: "Transfer request sent." };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to transfer pass." };
  }
}

export async function requestRefund(
  orderId: string,
  _prev: OrderState,
  formData: FormData
): Promise<OrderState> {
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    return { error: "Refund reason is required." };
  }
  try {
    await executeMutation(RequestRefundDocument, {
      input: { orderId, reason },
    });
    revalidatePath(`/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}/refund`);
    return { success: "Refund request submitted." };
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to request refund." };
  }
}
