"use server";
// app/actions/orders.ts — Server Actions for order mutations.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { executeMutation } from "@/lib/graphql/execute";
import { base, authHeaders } from "@/lib/server-utils";
import {
  CancelOrderDocument,
  CreateOrderDocument,
  CreatePaymentDocument,
  CreateSeatedOrderDocument,
} from "@/lib/graphql/generated";

export interface OrderState {
  error?: string;
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
  void formData;

  const token = process.env.STRIPE_TEST_TOKEN ?? "pm_card_visa";

  try {
    await executeMutation(CreatePaymentDocument, {
      input: { orderId, token },
    });
    revalidatePath(`/orders/${orderId}`);
    redirect(`/orders/${orderId}`);
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

// ─── Seat hold actions ────────────────────────────────────────────────────────

export interface SeatHoldState {
  error?: string;
  held?: string[];
  expiresAt?: string;
}

/**
 * Holds seats via venue-service.
 * Calls POST /api/seating-plans/:planId/seats/hold.
 */
export async function holdSeats(
  planId: string,
  seatIds: string[],
  sessionId: string
): Promise<SeatHoldState> {
  const res = await fetch(
    `${base()}/api/seating-plans/${planId}/seats/hold`,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ seatIds, sessionId }),
    }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // venue-service returns { error: "string" }, not { error: { message: "..." } }
    const msg = typeof body?.error === "string" ? body.error : (body?.error?.message ?? "Failed to hold seats.");
    return { error: msg };
  }

  const data = await res.json() as { held: string[]; expiresAt: string };
  return { held: data.held, expiresAt: data.expiresAt };
}

/**
 * Releases held seats via venue-service.
 * Calls POST /api/seating-plans/:planId/seats/release.
 */
export async function releaseSeats(
  planId: string,
  seatIds: string[]
): Promise<{ error?: string }> {
  const res = await fetch(
    `${base()}/api/seating-plans/${planId}/seats/release`,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ seatIds }),
    }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to release seats." };
  }

  return {};
}
