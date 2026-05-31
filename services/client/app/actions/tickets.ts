"use server";
// app/actions/tickets.ts — Server Actions for ticket mutations and queries.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { base, authHeaders } from "@/lib/server-utils";
import { executeQuery, executeMutation } from "@/lib/graphql/execute";
import { ApiError, serverApi } from "@/lib/api";
import {
  TicketsBrowseDocument,
  CreateTicketDocument,
  UpdateTicketDocument,
  UpdateSeatingPlanDocument,
  UpdateAttendancePolicyDocument,
  type TicketFilter,
} from "@/lib/graphql/generated";
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

async function isPubliclyAvailableSeatedTicket(planId: string): Promise<boolean> {
  const planRes = await fetch(`${base()}/api/seating-plans/${planId}`, {
    cache: "no-store",
  });
  if (!planRes.ok) return false;

  const plan = await planRes.json() as SeatingPlan;
  if (plan.status !== "active") return false;

  const availabilityRes = await fetch(`${base()}/api/seating-plans/${planId}/availability`, {
    cache: "no-store",
  });
  if (!availabilityRes.ok) return false;

  const availability = await availabilityRes.json() as AvailabilitySnapshot;
  return availability.counts.available > 0;
}

/**
 * Fetches one page of available (unreserved) tickets using cursor-based
 * pagination via GraphQL. Pass `after=null` for the first page; subsequent pages use the
 * `cursor` returned from the previous call.
 *
 * This is a Server Action so it can be called from Client Components without
 * exposing the internal API URL or auth cookie logic to the browser.
 */
export async function fetchTicketPageViaGraphQL(after: string | null, filter?: TicketFilter): Promise<TicketPage> {
  const applySeatedVisibility = async (tickets: Ticket[]): Promise<Ticket[]> => {
    const visible = await Promise.all(
      tickets.map(async (ticket) => {
        if (!ticket.seatingPlanId) return ticket;
        return (await isPubliclyAvailableSeatedTicket(ticket.seatingPlanId)) ? ticket : null;
      })
    );
    return visible.filter((ticket): ticket is Ticket => ticket !== null);
  };

  try {
    const cookieStore = await cookies();
    const cookieHeader = cookieStore.toString();

    const data = await executeQuery(
      TicketsBrowseDocument,
      { first: PAGE_SIZE, after: after || undefined, filter },
      { cookie: cookieHeader }
    );

    if (!data.ticketsConnection) {
      return { tickets: [], cursor: null, hasMore: false };
    }

    const gqlTickets = data.ticketsConnection.edges.map((edge) => ({
      id: edge.node.id,
      title: edge.node.title,
      price: String(edge.node.price),
      available: edge.node.available,
      ticketType: edge.node.ticketType,
      seatingPlanId: edge.node.seatingPlan?.id ?? null,
      event: edge.node.event ? {
        title: edge.node.event.title,
        startsAt: edge.node.event.startsAt,
        venueName: edge.node.event.venueName,
      } : undefined,
    }));

    const visibleTickets = await applySeatedVisibility(gqlTickets as unknown as Ticket[]);
    return {
      tickets: visibleTickets as unknown as Ticket[],
      cursor: data.ticketsConnection.pageInfo.endCursor ?? null,
      hasMore: data.ticketsConnection.pageInfo.hasNextPage,
    };
  } catch {
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), available: "true" });
      if (after) params.set("after", after);
      const restTickets = await serverApi<Ticket[]>(`/api/tickets?${params.toString()}`);
      const visibleTickets = await applySeatedVisibility(restTickets);
      return {
        tickets: visibleTickets,
        cursor: restTickets.at(-1)?.id ?? null,
        hasMore: restTickets.length === PAGE_SIZE,
      };
    } catch {
      // Non-fatal: return empty page so the UI degrades gracefully.
      return { tickets: [], cursor: null, hasMore: false };
    }
  }
}

export interface TicketState {
  error?: string;
  refreshed?: true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse an optional positive integer from a FormData field. Returns undefined if blank. */
function parseOptionalPositiveInt(raw: string | null): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}

function parseRequireQrForEntry(raw: string | null): boolean {
  if (!raw) return true;
  return raw.toLowerCase() !== "false";
}

async function linkSeatingPlanToTicket(
  ticketId: string,
  seatingPlanId: string
): Promise<string | null> {
  try {
    await executeMutation(UpdateTicketDocument, { id: ticketId, input: { seatingPlanId } });
    return null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect("/auth/signin");
    return err instanceof Error ? err.message : "Failed to attach seating plan to ticket.";
  }
}

async function upsertAttendanceSettings(eventId: string, requireQrForEntry: boolean): Promise<string | null> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await executeMutation(UpdateAttendancePolicyDocument, {
        eventId,
        input: { requireQrForEntry },
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save attendance settings.";
      const isNotFound = String(message).toLowerCase().includes("event not found");
      if (!isNotFound) return message;
      if (attempt === 8) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return null;
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
  const requireQrForEntry = parseRequireQrForEntry(formData.get("requireQrForEntry") as string | null);

  // GA-specific
  const quota = parseOptionalPositiveInt(formData.get("quota") as string | null);
  const maxPerUser = parseOptionalPositiveInt(formData.get("maxPerUser") as string | null);

  // Seated-specific (Phase 3: venueId instead of seatingPlanId)
  const venueId = (formData.get("venueId") as string | null) ?? "";
  const maxSeatsPerOrder = parseOptionalPositiveInt(formData.get("maxSeatsPerOrder") as string | null);

  // Section/seat pricing: price is configured in the plan editor, not on the ticket.
  const deferredPricing = pricingMode === "seat" || pricingMode === "section";

  if (!title?.trim()) return { error: "Title is required." };
  if (!deferredPricing) {
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
  // Deferred pricing (section/seat): send "0" placeholder — actual prices come from the plan editor.
  const effectivePrice = deferredPricing ? "0" : priceRaw;
  const reqBody: Record<string, unknown> = { title: title.trim(), price: effectivePrice };

  if (ticketType === "GA") {
    if (quota !== undefined) reqBody.quota = quota;
    if (maxPerUser !== undefined) reqBody.maxPerUser = maxPerUser;
  } else if (ticketType.startsWith("SEATED")) {
    // For seated tickets, quota is 0 (managed by venue-service)
    reqBody.quota = 0;
    if (maxSeatsPerOrder !== undefined) reqBody.maxPerUser = maxSeatsPerOrder;
  }

  const gqlTicketType = ticketType.startsWith("SEATED") ? "SEATED" : "GENERAL_ADMISSION";
  const priceInCents = Math.round(parseFloat(effectivePrice) * 100);
  const eventInput = {
    startsAt: startsAt!,
    ...(eventTitle && { title: eventTitle }),
    ...(endsAt && { endsAt }),
    ...(eventDescription && { description: eventDescription }),
    ...(eventImageUrl && { imageUrl: eventImageUrl }),
    ...(venueName && { venueName }),
    ...(venueAddress && { venueAddress }),
  };

  let ticket: { id: string; title: string; priceDecimal: string };
  try {
    const result = await executeMutation(CreateTicketDocument, {
      input: {
        title: title.trim(),
        price: priceInCents,
        quota: (reqBody.quota as number | undefined) ?? 0,
        ...(reqBody.maxPerUser !== undefined && { maxPerUser: reqBody.maxPerUser as number }),
        ticketType: gqlTicketType,
        event: eventInput,
      },
    });
    ticket = result.createTicket;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create ticket.";
    return { error: msg };
  }

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

    const updateError = await linkSeatingPlanToTicket(ticket.id, plan.id);

    if (updateError) {
      return { error: updateError };
    }
  }

  const attendanceError = await upsertAttendanceSettings(ticket.id, requireQrForEntry);
  if (attendanceError) {
    return { error: attendanceError };
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
  const pricingMode = (formData.get("pricingMode") as string | null) ?? "single";
  const deferredPricing = pricingMode === "seat" || pricingMode === "section";
  const seatingPlanId = (formData.get("seatingPlanId") as string | null)?.trim() || "";
  const maxSeatsPerOrder = parseOptionalPositiveInt(formData.get("maxSeatsPerOrder") as string | null);
  const quota = parseOptionalPositiveInt(formData.get("quota") as string | null);
  const maxPerUser = parseOptionalPositiveInt(formData.get("maxPerUser") as string | null);
  let startsAt = (formData.get("startsAt") as string)?.trim() || "";
  let endsAt = (formData.get("endsAt") as string)?.trim() || "";
  const eventTitle = (formData.get("eventTitle") as string)?.trim() || "";
  const eventDescription = (formData.get("eventDescription") as string)?.trim() || "";
  const eventImageUrl = (formData.get("eventImageUrl") as string)?.trim() || "";
  const venueName = (formData.get("venueName") as string)?.trim() || "";
  const venueAddress = (formData.get("venueAddress") as string)?.trim() || "";
  const requireQrForEntry = parseRequireQrForEntry(formData.get("requireQrForEntry") as string | null);

  if (!title?.trim()) return { error: "Title is required." };
  if (!deferredPricing && (!priceRaw || isNaN(priceNum) || priceNum <= 0)) {
    return { error: "Price must be a positive number." };
  }
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

  const updateInput = {
    title: title.trim(),
    ...(deferredPricing ? {} : { price: Math.round(priceNum * 100) }),
    ...(quota !== undefined && { quota }),
    ...(maxPerUser !== undefined && { maxPerUser }),
    event: {
      title: eventTitle || undefined,
      description: eventDescription || undefined,
      startsAt,
      imageUrl: eventImageUrl || undefined,
      venueName: venueName || undefined,
      venueAddress: venueAddress || undefined,
      ...(endsAt ? { endsAt } : {}),
    },
  };

  try {
    await executeMutation(UpdateTicketDocument, { id: ticketId, input: updateInput });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect("/auth/signin");
    const msg = err instanceof Error ? err.message : "Failed to update ticket.";
    return { error: msg };
  }

  // pricingMode and maxSeatsPerOrder live on the SeatingPlan, not the Ticket — route them to the plan.
  const planInput = {
    ...(formData.get("pricingMode") ? { pricingMode } : {}),
    ...(maxSeatsPerOrder !== undefined && { maxSeatsPerOrder }),
  };
  if (seatingPlanId && Object.keys(planInput).length > 0) {
    try {
      await executeMutation(UpdateSeatingPlanDocument, {
        id: seatingPlanId,
        input: planInput,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) redirect("/auth/signin");
      const msg = err instanceof Error ? err.message : "Failed to update plan settings.";
      return { error: msg };
    }
  }

  const attendanceError = await upsertAttendanceSettings(ticketId, requireQrForEntry);
  if (attendanceError) {
    return { error: attendanceError };
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/");
  return { refreshed: true };
}

export async function replaceInactivePlan(
  ticketId: string,
  currentPlanId: string,
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

  const updateError = await linkSeatingPlanToTicket(ticketId, replacementPlan.id);
  if (updateError) {
    return { error: updateError };
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/tickets/${ticketId}/plans/${currentPlanId}`);
  revalidatePath(`/tickets/${ticketId}/plans/${replacementPlan.id}`);
  redirect(`/tickets/${ticketId}/plans/${replacementPlan.id}`);
}
