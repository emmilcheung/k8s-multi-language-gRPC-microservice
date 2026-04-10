"use server";
// app/actions/orders.ts — Server Actions for order mutations.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";

export interface OrderState {
  error?: string;
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

  const res = await fetch(`${base()}/api/orders`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ ticketId, quantity }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to create order." };
  }

  const order = await res.json();
  revalidatePath("/orders");
  redirect(`/orders/${order.id}`);
}

export async function cancelOrder(
  orderId: string,
  _prev: OrderState,
  _formData: FormData
): Promise<OrderState> {
  const res = await fetch(`${base()}/api/orders/${orderId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to cancel order." };
  }

  revalidatePath("/orders");
  redirect("/orders");
}

export async function submitPayment(
  orderId: string,
  _prev: OrderState,
  _formData: FormData
): Promise<OrderState> {
  const token = process.env.STRIPE_TEST_TOKEN ?? "pm_card_visa";

  const res = await fetch(`${base()}/api/payments`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ orderId, token }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Payment failed." };
  }

  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

// ─── Seated order actions ─────────────────────────────────────────────────────

export interface SeatedOrderState {
  error?: string;
  /** Set when the order was created but a redirect is needed (client-side navigation). */
  orderId?: string;
}

/**
 * Creates a seated order for manually-selected seats.
 * Calls POST /api/orders/seated with ticketId, planId, seatIds (MANUAL_SEATED flow).
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

  const res = await fetch(`${base()}/api/orders/seated`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      ticketId,
      planId,
      seatIds,
      quantity: seatIds.length,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to create seated order." };
  }

  const order = await res.json();
  revalidatePath("/orders");
  redirect(`/orders/${order.id}`);
}

/**
 * Creates a seated order using auto-assign (best-available).
 * Calls POST /api/orders/seated with ticketId, planId, sectionId, quantity (AUTO_ASSIGN_SEATED flow).
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

  const res = await fetch(`${base()}/api/orders/seated`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ ticketId, planId, sectionId, quantity }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to create auto-assign order." };
  }

  const order = await res.json();
  revalidatePath("/orders");
  redirect(`/orders/${order.id}`);
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
