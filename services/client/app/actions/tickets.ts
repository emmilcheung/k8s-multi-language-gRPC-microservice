"use server";
// app/actions/tickets.ts — Server Actions for ticket mutations.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";

export interface TicketState {
  error?: string;
}

export async function createTicket(
  _prev: TicketState,
  formData: FormData
): Promise<TicketState> {
  const title = formData.get("title") as string;
  const priceRaw = formData.get("price") as string;
  const price = parseFloat(priceRaw);

  if (!title?.trim()) return { error: "Title is required." };
  if (isNaN(price) || price <= 0) return { error: "Price must be a positive number." };

  const res = await fetch(`${base()}/api/tickets`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ title: title.trim(), price }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to create ticket." };
  }

  const ticket = await res.json();
  revalidatePath("/");
  redirect(`/tickets/${ticket.id}`);
}

export async function updateTicket(
  ticketId: string,
  _prev: TicketState,
  formData: FormData
): Promise<TicketState> {
  const title = formData.get("title") as string;
  const priceRaw = formData.get("price") as string;
  const price = parseFloat(priceRaw);

  if (!title?.trim()) return { error: "Title is required." };
  if (isNaN(price) || price <= 0) return { error: "Price must be a positive number." };

  const res = await fetch(`${base()}/api/tickets/${ticketId}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ title: title.trim(), price }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to update ticket." };
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/");
  redirect(`/tickets/${ticketId}`);
}
