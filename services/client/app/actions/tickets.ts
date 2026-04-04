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
  url.searchParams.set("available", "true");
  if (after) url.searchParams.set("after", after);

  // Public endpoint — no auth cookie required.
  const res = await fetch(url.toString(), { cache: "no-store" });

  if (!res.ok) {
    // Non-fatal: return empty page so the UI degrades gracefully.
    return { tickets: [], cursor: null, hasMore: false };
  }

  const all: Ticket[] = await res.json();
  // Compound cursor: "<createdAtUnixMilli>:<id>" matches the backend EncodeCursor format.
  const lastTicket = all.length > 0 ? all[all.length - 1] : null;
  const cursor = lastTicket?.createdAt
    ? `${new Date(lastTicket.createdAt).getTime()}:${lastTicket.id}`
    : (lastTicket?.id ?? null);
  const hasMore = all.length === PAGE_SIZE;
  return { tickets: all, cursor, hasMore };
}

export interface TicketState {
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse an optional positive integer from a FormData field. Returns undefined if blank. */
function parseOptionalPositiveInt(raw: string | null): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function createTicket(
  _prev: TicketState,
  formData: FormData
): Promise<TicketState> {
  const title = formData.get("title") as string;
  const priceRaw = (formData.get("price") as string)?.trim();
  const priceNum = parseFloat(priceRaw);
  const ticketType = (formData.get("ticketType") as string | null) ?? "";
  const seatingPlanId = (formData.get("seatingPlanId") as string | null) ?? "";
  const pricingMode = (formData.get("pricingMode") as string | null) ?? "single";

  // GA-specific
  const quota = parseOptionalPositiveInt(formData.get("quota") as string | null);
  const maxPerUser = parseOptionalPositiveInt(formData.get("maxPerUser") as string | null);

  // Seated-specific
  const maxSeatsPerOrder = parseOptionalPositiveInt(formData.get("maxSeatsPerOrder") as string | null);

  if (!title?.trim()) return { error: "Title is required." };
  // Seat pricing: price is configured per-seat in the plan editor, not on the ticket.
  if (pricingMode !== "seat") {
    if (!priceRaw || isNaN(priceNum) || priceNum <= 0) return { error: "Price must be a positive number." };
  }

  // Event metadata
  let startsAt = (formData.get("startsAt") as string)?.trim() || null;
  let endsAt = (formData.get("endsAt") as string)?.trim() || null;

  // Convert datetime-local format (YYYY-MM-DDTHH:mm) to RFC3339 ISO 8601 (YYYY-MM-DDTHH:mm:ssZ)
  // Go's time.Time JSON unmarshaler expects RFC3339 format
  if (startsAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startsAt)) {
    startsAt += ':00Z'; // Add :00Z to make RFC3339 format that Go can parse
  }
  if (endsAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endsAt)) {
    endsAt += ':00Z';
  }
  const eventTitle = (formData.get("eventTitle") as string)?.trim() || null;
  const eventDescription = (formData.get("eventDescription") as string)?.trim() || null;
  const eventImageUrl = (formData.get("eventImageUrl") as string)?.trim() || null;
  const venueName = (formData.get("venueName") as string)?.trim() || null;
  const venueAddress = (formData.get("venueAddress") as string)?.trim() || null;

  if (!startsAt) return { error: "Event start date/time is required." };

  // Validation for GA
  if (ticketType === "GA") {
    if (maxPerUser !== undefined && quota !== undefined && maxPerUser > quota) {
      return { error: "Max per buyer cannot exceed the total capacity." };
    }
  }

  // Validation for Seated
  if (ticketType.startsWith("SEATED")) {
    if (!seatingPlanId) return { error: "Seating plan ID is required." };
    if (!UUID_RE.test(seatingPlanId)) return { error: "Seating plan ID must be a valid UUID." };
  }

  // Create the base ticket
  // Seat pricing: send "0" as placeholder — actual price comes from per-seat plan configuration.
  const effectivePrice = pricingMode === "seat" ? "0" : priceRaw;
  const reqBody: Record<string, unknown> = { title: title.trim(), price: effectivePrice };

  if (ticketType === "GA") {
    if (quota !== undefined) reqBody.quota = quota;
    if (maxPerUser !== undefined) reqBody.maxPerUser = maxPerUser;
  } else if (ticketType.startsWith("SEATED")) {
    // For seated tickets, quota is 0 (managed by venue-service)
    reqBody.quota = 0;
    if (maxSeatsPerOrder !== undefined) reqBody.maxPerUser = maxSeatsPerOrder;
  }

  // Attach event sub-document — backend TicketEvent struct already handles this
  reqBody.event = {
    startsAt,
    ...(eventTitle && { title: eventTitle }),
    ...(endsAt && { endsAt }),
    ...(eventDescription && { description: eventDescription }),
    ...(eventImageUrl && { imageUrl: eventImageUrl }),
    ...(venueName && { venueName }),
    ...(venueAddress && { venueAddress }),
  };

  const res = await fetch(`${base()}/api/tickets`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    return { error: errBody?.error?.message ?? "Failed to create ticket." };
  }

  const ticket = await res.json();

  // WS3: If seating plan, attach it now
  if (ticketType.startsWith("SEATED") && seatingPlanId) {
    const attachRes = await fetch(`${base()}/api/tickets/${ticket.id}/seating-plan`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ seatingPlanId }),
    });

    if (!attachRes.ok) {
      const errBody = await attachRes.json().catch(() => ({}));
      // Non-fatal: ticket was created but plan attachment failed
      console.warn("[createTicket] seating plan attachment failed:", errBody?.error);
      // Continue to redirect anyway
    }

    // Also attach ticket to plan in venue-service
    const planAttachRes = await fetch(`${base()}/api/seating-plans/${seatingPlanId}/attach-ticket`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ ticketId: ticket.id }),
    });

    if (!planAttachRes.ok) {
      console.warn("[createTicket] venue-service attach failed, continuing...");
    }
  }

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
  const quota = parseOptionalPositiveInt(formData.get("quota") as string | null);
  const maxPerUser = parseOptionalPositiveInt(formData.get("maxPerUser") as string | null);

  if (!title?.trim()) return { error: "Title is required." };
  if (!priceRaw || isNaN(priceNum) || priceNum <= 0) return { error: "Price must be a positive number." };
  if (maxPerUser !== undefined && quota !== undefined && maxPerUser > quota) {
    return { error: "Max per buyer cannot exceed the total capacity." };
  }

  const reqBody: Record<string, unknown> = { title: title.trim(), price: priceRaw };
  if (quota !== undefined) reqBody.quota = quota;
  if (maxPerUser !== undefined) reqBody.maxPerUser = maxPerUser;

  const res = await fetch(`${base()}/api/tickets/${ticketId}`, {
    method: "PUT",
    headers: await authHeaders(),
    // ticket-service requires price as a decimal string (e.g. "25.00"), not a number
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    if (res.status === 401) redirect("/auth/signin");
    const errBody = await res.json().catch(() => ({}));
    // ticket-service: { error: { message: "..." } }; Kong: { message: "..." }
    const errMsg = errBody?.error?.message ?? errBody?.message ?? "Failed to update ticket.";
    return { error: errMsg };
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

  // 1. Verify the seating plan exists and belongs to the caller before linking it.
  const planRes = await fetch(`${base()}/api/seating-plans/${planId}`, {
    method: "GET",
    headers: await authHeaders(),
  });
  if (!planRes.ok) {
    return { error: "Seating plan not found or you do not have access to it." };
  }
  const plan = await planRes.json();

  // 2. Tell ticket-service about the plan (sets seatingPlanId on the ticket).
  const res = await fetch(`${base()}/api/tickets/${ticketId}/seating-plan`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ seatingPlanId: planId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? "Failed to attach seating plan." };
  }

  // 3. Tell venue-service about the ticket (sets ticketId on the plan).
  //    This is required so the activate button becomes visible on the plan page.
  const attachRes = await fetch(`${base()}/api/seating-plans/${planId}/attach-ticket`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ ticketId, expectedVersion: plan.version ?? 0 }),
  });

  if (!attachRes.ok) {
    // Non-fatal: ticket-service link succeeded. Log but don't block the redirect.
    // The organizer can still activate via the plan page after refreshing.
    const body = await attachRes.json().catch(() => ({}));
    console.warn("[attachSeatingPlan] venue-service attach-ticket failed:", body?.error);
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
