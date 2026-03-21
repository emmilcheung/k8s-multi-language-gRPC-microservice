"use server";
// app/actions/orders.ts — Server Actions for order mutations.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

const base = () =>
  (process.env.INTERNAL_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

async function authHeaders() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value ?? "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Cookie: `token=${token}` } : {}),
  };
}

export interface OrderState {
  error?: string;
}

export async function createOrder(
  ticketId: string,
  _prev: OrderState,
  _formData: FormData
): Promise<OrderState> {
  const res = await fetch(`${base()}/api/orders`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ ticketId }),
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
  amountDollars: number,
  _prev: OrderState,
  _formData: FormData
): Promise<OrderState> {
  // payment-service expects amount in the smallest currency unit (cents).
  // In dev/test we use Stripe's test payment method token directly.
  const amountCents = Math.round(amountDollars * 100);
  const token = process.env.STRIPE_TEST_TOKEN ?? "pm_card_visa";

  const res = await fetch(`${base()}/api/payments`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ orderId, amount: amountCents, token }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Payment failed." };
  }

  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}
