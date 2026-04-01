"use server";
// app/actions/tickets.ts — Server Actions for ticket mutations and queries.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";
import type { Ticket } from "@/lib/types";

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface TicketPage {
  tickets: Ticket[];
  /** ID of the last ticket in this page; pass as `after` to fetch the next page. */
  cursor: string | null;
  /** True when fewer than `limit` results were returned — no more pages exist. */
  hasMore: boolean;
}

const PAGE_SIZE = 20;

/**
 * Fetches one page of available (unreserved) tickets using cursor-based
 * pagination. Pass `after=null` for the first page; subsequent pages use the
 * `cursor` returned from the previous call.
 *
 * This is a Server Action so it can be called from Client Components without
 * exposing the internal API URL or auth cookie logic to the browser.
 */
export async function fetchTicketPage(after: string | null): Promise<TicketPage> {
  const url = new URL(`${base()}/api/tickets`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (after) url.searchParams.set("after", after);

  // Public endpoint — no auth cookie required. Use ISR caching via the
  // Next.js fetch cache (revalidate: 10 s) so repeated "Load more" calls on
  // the same cursor hit the cache rather than the upstream.
  const res = await fetch(url.toString(), {
    next: { revalidate: 10 },
  });

  if (!res.ok) {
    // Non-fatal: return empty page so the UI degrades gracefully.
    return { tickets: [], cursor: null, hasMore: false };
  }

  const all: Ticket[] = await res.json();
  const cursor = all.length > 0 ? all[all.length - 1].id : null;
  const hasMore = all.length === PAGE_SIZE;
  return { tickets: all, cursor, hasMore };
}

export interface TicketState {
  error?: string;
}

export async function createTicket(
  _prev: TicketState,
  formData: FormData
): Promise<TicketState> {
  const title = formData.get("title") as string;
  const priceRaw = (formData.get("price") as string)?.trim();
  const priceNum = parseFloat(priceRaw);

  if (!title?.trim()) return { error: "Title is required." };
  if (!priceRaw || isNaN(priceNum) || priceNum <= 0) return { error: "Price must be a positive number." };

  const res = await fetch(`${base()}/api/tickets`, {
    method: "POST",
    headers: await authHeaders(),
    // ticket-service requires price as a decimal string (e.g. "25.00"), not a number
    body: JSON.stringify({ title: title.trim(), price: priceRaw }),
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
  const priceRaw = (formData.get("price") as string)?.trim();
  const priceNum = parseFloat(priceRaw);

  if (!title?.trim()) return { error: "Title is required." };
  if (!priceRaw || isNaN(priceNum) || priceNum <= 0) return { error: "Price must be a positive number." };

  const res = await fetch(`${base()}/api/tickets/${ticketId}`, {
    method: "PUT",
    headers: await authHeaders(),
    // ticket-service requires price as a decimal string (e.g. "25.00"), not a number
    body: JSON.stringify({ title: title.trim(), price: priceRaw }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to update ticket." };
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/");
  redirect(`/tickets/${ticketId}`);
}

// ─── Seating plan attach / detach (CP-14) ────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Attaches a seating plan to a ticket.
 * Calls PATCH /api/tickets/:ticketId/seating-plan via Kong → ticket-service.
 */
export async function attachSeatingPlan(
  ticketId: string,
  _prev: TicketState,
  formData: FormData
): Promise<TicketState> {
  const planId = (formData.get("planId") as string | null)?.trim() ?? "";

  if (!planId) return { error: "Seating plan ID is required." };
  if (!UUID_RE.test(planId)) return { error: "Seating plan ID must be a valid UUID." };

  const res = await fetch(`${base()}/api/tickets/${ticketId}/seating-plan`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify({ seatingPlanId: planId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to attach seating plan." };
  }

  revalidatePath(`/tickets/${ticketId}`);
  redirect(`/tickets/${ticketId}`);
}

/**
 * Detaches the seating plan from a ticket.
 * Calls DELETE /api/tickets/:ticketId/seating-plan via Kong → ticket-service.
 */
export async function detachSeatingPlan(
  ticketId: string,
  _prev: TicketState,
  _formData: FormData
): Promise<TicketState> {
  const res = await fetch(`${base()}/api/tickets/${ticketId}/seating-plan`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to detach seating plan." };
  }

  revalidatePath(`/tickets/${ticketId}`);
  redirect(`/tickets/${ticketId}`);
}
