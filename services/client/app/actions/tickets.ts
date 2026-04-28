"use server";
// app/actions/tickets.ts — Server Actions for ticket mutations and queries.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";
import type { AvailabilitySnapshot, SeatingPlan, Ticket } from "@/lib/types";
import { createSeatingPlanForTicket } from "./venues";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface TicketPage {
  tickets: Ticket[];
  /** ID of the last ticket in this page; pass as `after` to fetch the next page. */
  cursor: string | null;
  /** True when fewer than `limit` results were returned — no more pages exist. */
  hasMore: boolean;
}

const PAGE_SIZE = 20;

async function isPubliclyAvailableTicket(ticket: Ticket): Promise<boolean> {
  if (!ticket.seatingPlanId) {
    return !ticket.orderId;
  }

  const [planRes, availabilityRes] = await Promise.all([
    fetch(`${base()}/api/seating-plans/${ticket.seatingPlanId}`, { cache: "no-store" }),
    fetch(`${base()}/api/seating-plans/${ticket.seatingPlanId}/availability`, { cache: "no-store" }),
  ]);

  if (!planRes.ok || !availabilityRes.ok) {
    return false;
  }

  const plan = await planRes.json() as SeatingPlan;
  const availability = await availabilityRes.json() as AvailabilitySnapshot;

  return plan.status === "active" && availability.counts.available > 0;
}

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
  const filtered = await Promise.all(
    all.map(async (ticket) => ((await isPubliclyAvailableTicket(ticket)) ? ticket : null))
  );
  const tickets = filtered.filter((ticket): ticket is Ticket => ticket !== null);
  // Compound cursor: "<createdAtUnixMilli>:<id>" matches the backend EncodeCursor format.
  const lastTicket = all.length > 0 ? all[all.length - 1] : null;
  const cursor = lastTicket?.createdAt
    ? `${new Date(lastTicket.createdAt).getTime()}:${lastTicket.id}`
    : (lastTicket?.id ?? null);
  const hasMore = all.length === PAGE_SIZE;
  return { tickets, cursor, hasMore };
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

async function linkSeatingPlanToTicket(
  ticketId: string,
  title: string,
  price: string,
  seatingPlanId: string,
  ticketType: string
): Promise<string | null> {
  const updateRes = await fetch(`${base()}/api/tickets/${ticketId}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({
      title,
      price,
      seatingPlanId,
      ticketType,
    }),
  });

  if (updateRes.ok) return null;

  const errBody = await updateRes.json().catch(() => ({}));
  return errBody?.error?.message ?? "Failed to attach seating plan to ticket.";
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Phase 3: ticket-first seating plan creation.
 * When creating a seated ticket, this action:
 * 1. Creates the ticket in ticket-service
 * 2. If seated and venueId is provided, creates a seating plan in venue-service with ticketId
 * 3. Updates the ticket with the new seatingPlanId
 */
export async function createTicket(
  _prev: TicketState,
  formData: FormData
): Promise<TicketState> {
  const title = formData.get("title") as string;
  const priceRaw = (formData.get("price") as string)?.trim();
  const priceNum = parseFloat(priceRaw);
  const ticketType = (formData.get("ticketType") as string | null) ?? "";
  const pricingMode = (formData.get("pricingMode") as string | null) ?? "single";

  // GA-specific
  const quota = parseOptionalPositiveInt(formData.get("quota") as string | null);
  const maxPerUser = parseOptionalPositiveInt(formData.get("maxPerUser") as string | null);

  // Seated-specific (Phase 3: venueId instead of seatingPlanId)
  const venueId = (formData.get("venueId") as string | null) ?? "";
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

  // Validation for Seated (Phase 3: now requires venueId, not seatingPlanId)
  if (ticketType.startsWith("SEATED")) {
    if (!venueId) return { error: "Venue is required for seated tickets." };
    if (!UUID_RE.test(venueId)) return { error: "Venue ID must be a valid UUID." };
  }

  // Create the base ticket (without seatingPlanId initially)
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

  // Phase 3: If seating plan, create it with ticketId (no separate attach)
  if (ticketType.startsWith("SEATED") && venueId) {
    const planName = `${title.trim()} Seating Plan`;
    const assignmentMode = ticketType === "SEATED_AUTO" ? "auto" : "manual";
    const plan = await createSeatingPlanForTicket(
      ticket.id,
      venueId,
      planName,
      assignmentMode,
      maxSeatsPerOrder,
    );

    if (!plan) {
      return { error: "Failed to create seating plan for this ticket." };
    }

    const updateError = await linkSeatingPlanToTicket(
      ticket.id,
      ticket.title,
      ticket.price,
      plan.id,
      ticketType
    );

    if (updateError) {
      return { error: updateError };
    }
  }

  revalidatePath("/");
  revalidatePath(`/tickets/${ticket.id}`);
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
  let startsAt = (formData.get("startsAt") as string)?.trim() || "";
  let endsAt = (formData.get("endsAt") as string)?.trim() || "";
  const eventTitle = (formData.get("eventTitle") as string)?.trim() || "";
  const eventDescription = (formData.get("eventDescription") as string)?.trim() || "";
  const eventImageUrl = (formData.get("eventImageUrl") as string)?.trim() || "";
  const venueName = (formData.get("venueName") as string)?.trim() || "";
  const venueAddress = (formData.get("venueAddress") as string)?.trim() || "";

  if (!title?.trim()) return { error: "Title is required." };
  if (!priceRaw || isNaN(priceNum) || priceNum <= 0) return { error: "Price must be a positive number." };
  if (maxPerUser !== undefined && quota !== undefined && maxPerUser > quota) {
    return { error: "Max per buyer cannot exceed the total capacity." };
  }
  if (!startsAt) return { error: "Event start date/time is required." };

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startsAt)) {
    startsAt += ":00Z";
  }
  if (endsAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endsAt)) {
    endsAt += ":00Z";
  }

  const reqBody: Record<string, unknown> = { title: title.trim(), price: priceRaw };
  if (quota !== undefined) reqBody.quota = quota;
  if (maxPerUser !== undefined) reqBody.maxPerUser = maxPerUser;
  reqBody.event = {
    title: eventTitle,
    description: eventDescription,
    startsAt,
    imageUrl: eventImageUrl,
    venueName,
    venueAddress,
    ...(endsAt ? { endsAt } : {}),
  };

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

export async function replaceInactivePlan(
  ticketId: string,
  currentPlanId: string,
  title: string,
  price: string,
  fallbackTicketType: string,
  _prev: TicketState,
  _formData: FormData
): Promise<TicketState> {
  void _prev;
  void _formData;

  if (!ticketId || !currentPlanId) {
    return { error: "Ticket and seating plan are required." };
  }

  const planRes = await fetch(`${base()}/api/seating-plans/${currentPlanId}`, {
    method: "GET",
    cache: "no-store",
    headers: await authHeaders(),
  });

  if (!planRes.ok) {
    const errBody = await planRes.json().catch(() => ({}));
    return { error: errBody?.error ?? "Failed to load the current seating plan." };
  }

  const currentPlan = (await planRes.json()) as SeatingPlan;
  if (currentPlan.ticketId !== ticketId) {
    return { error: "This seating plan is not attached to the current ticket." };
  }
  if (currentPlan.status !== "inactive") {
    return { error: "Only inactive plans can be replaced." };
  }

  const assignmentMode = currentPlan.assignmentMode === "auto" ? "auto" : "manual";
  const ticketType =
    assignmentMode === "auto"
      ? "SEATED_AUTO"
      : fallbackTicketType === "SEATED_AUTO"
        ? "SEATED_AUTO"
        : "SEATED_MANUAL";
  const replacementName = currentPlan.name.includes("Replacement")
    ? currentPlan.name
    : `${currentPlan.name} Replacement`;

  const replacementPlan = await createSeatingPlanForTicket(
    ticketId,
    currentPlan.venueId,
    replacementName,
    assignmentMode,
    currentPlan.maxSeatsPerOrder,
    currentPlan.pricingMode
  );

  if (!replacementPlan) {
    return { error: "Failed to create a replacement seating plan." };
  }

  const updateError = await linkSeatingPlanToTicket(
    ticketId,
    title,
    price,
    replacementPlan.id,
    ticketType
  );
  if (updateError) {
    return { error: updateError };
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/tickets/${ticketId}/plans/${currentPlanId}`);
  revalidatePath(`/tickets/${ticketId}/plans/${replacementPlan.id}`);
  redirect(`/tickets/${ticketId}/plans/${replacementPlan.id}`);
}

