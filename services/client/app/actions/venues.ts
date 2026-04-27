"use server";
// app/actions/venues.ts — Server Actions for venue and seating-plan mutations.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";
import type { SeatingPlan, PriceTier, VenueSection } from "@/lib/types";

// ─── Venue types ─────────────────────────────────────────────────────────────

export interface Venue {
  id: string;
  organizerId: string;
  name: string;
  capacity: number;
  timezone: string;
  address?: string;
  version: number;
}

export interface VenueState {
  error?: string;
}

export interface PlanState {
  error?: string;
}

// ─── Venue mutations ──────────────────────────────────────────────────────────

/**
 * Fetches all venues belonging to the authenticated organizer.
 * GET /api/venues — Kong → venue-service.
 */
export async function fetchMyVenues(): Promise<Venue[]> {
  const res = await fetch(`${base()}/api/venues`, {
    cache: "no-store",
    headers: await authHeaders(),
  });

  if (!res.ok) return [];

  const data = await res.json();
  return (data?.venues ?? []) as Venue[];
}

/**
 * Fetches a single venue by ID.
 * GET /api/venues/:id — Kong → venue-service.
 */
export async function fetchVenue(venueId: string): Promise<Venue | null> {
  const res = await fetch(`${base()}/api/venues/${venueId}`, {
    cache: "no-store",
    headers: await authHeaders(),
  });

  if (!res.ok) return null;
  return res.json() as Promise<Venue>;
}

/**
 * Creates a new venue.
 * POST /api/venues — Kong → venue-service.
 */
export async function createVenue(
  _prev: VenueState,
  formData: FormData
): Promise<VenueState> {
  const name = (formData.get("name") as string)?.trim();
  const capacityRaw = (formData.get("capacity") as string)?.trim();
  const timezone = (formData.get("timezone") as string)?.trim();
  const address = (formData.get("address") as string)?.trim() ?? "";

  if (!name) return { error: "Venue name is required." };

  const capacity = parseInt(capacityRaw, 10);
  if (!capacityRaw || !Number.isFinite(capacity) || capacity < 1) {
    return { error: "Capacity must be a positive integer." };
  }

  if (!timezone) return { error: "Timezone is required." };

  const res = await fetch(`${base()}/api/venues`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ name, capacity, timezone, address }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to create venue." };
  }

  const venue = await res.json();
  revalidatePath("/venues");
  redirect(`/venues/${venue.id}`);
}

// ─── Venue section template mutations ────────────────────────────────────────

/**
 * Fetches the template sections for a venue.
 * GET /api/venues/:venueId/sections — Kong → venue-service.
 */
export async function fetchVenueSections(venueId: string): Promise<VenueSection[]> {
  const res = await fetch(`${base()}/api/venues/${venueId}/sections`, {
    cache: "no-store",
    headers: await authHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.sections ?? []) as VenueSection[];
}

/**
 * Adds a template section to a venue.
 * POST /api/venues/:venueId/sections — Kong → venue-service.
 */
export async function createVenueSection(
  venueId: string,
  _prev: VenueState,
  formData: FormData
): Promise<VenueState> {
  const name = (formData.get("name") as string)?.trim();
  const type = (formData.get("type") as string)?.trim();
  const rowCountRaw = (formData.get("rowCount") as string)?.trim();
  const columnCountRaw = (formData.get("columnCount") as string)?.trim();

  if (!name) return { error: "Section name is required." };
  if (type !== "seated" && type !== "ga") return { error: "Type must be 'seated' or 'ga'." };

  const rowCount = rowCountRaw ? parseInt(rowCountRaw, 10) : 0;
  const columnCount = columnCountRaw ? parseInt(columnCountRaw, 10) : 0;

  if (type === "seated" && (rowCount < 1 || columnCount < 1)) {
    return { error: "Seated sections require at least 1 row and 1 column." };
  }
  if (type === "ga" && columnCount < 1) {
    return { error: "GA sections require capacity >= 1." };
  }

  const res = await fetch(`${base()}/api/venues/${venueId}/sections`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ name, type, rowCount, columnCount }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to add section." };
  }

  revalidatePath(`/venues/${venueId}`);
  redirect(`/venues/${venueId}`);
}

/**
 * Removes a template section from a venue.
 * DELETE /api/venues/:venueId/sections/:sectionId — Kong → venue-service.
 *
 * Designed for `.bind(null, venueId, sectionId)` so it becomes a form action.
 */
export async function deleteVenueSection(
  venueId: string,
  sectionId: string,
  prev: VenueState,
  formData: FormData
): Promise<VenueState> {
  void prev;
  void formData;

  const res = await fetch(`${base()}/api/venues/${venueId}/sections/${sectionId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to remove section." };
  }

  revalidatePath(`/venues/${venueId}`);
  redirect(`/venues/${venueId}`);
}

// ─── Seating plan mutations ───────────────────────────────────────────────────

/**
 * Fetches all seating plans the organizer has created for a given venue.
 * There's no direct "list by venue" endpoint, so we use the seating plan list
 * endpoint filtered via query param (?venueId=...) if supported, otherwise
 * we rely on the UI to pass plans obtained from plan creation.
 */
export async function fetchPlansByVenue(venueId: string): Promise<SeatingPlan[]> {
  // venue-service exposes GET /api/seating-plans with optional ?venueId filter
  const url = new URL(`${base()}/api/seating-plans`);
  url.searchParams.set("venueId", venueId);

  const res = await fetch(url.toString(), {
    cache: "no-store",
    headers: await authHeaders(),
  });

  if (!res.ok) return [];

  const data = await res.json();
  // API returns { plans: [...] } or array directly
  if (Array.isArray(data)) return data as SeatingPlan[];
  return (data?.plans ?? []) as SeatingPlan[];
}

/**
 * Fetches all seating plans the organizer has created across all their venues.
 * Calls GET /api/venues to get the list of venues, then GET /api/seating-plans?venueId=X
 * for each venue and merges the results.
 *
 * Used by the ticket detail page to populate the "Attach seating plan" dropdown.
 */
export async function fetchAllMyPlans(): Promise<SeatingPlan[]> {
  const venues = await fetchMyVenues();
  if (venues.length === 0) return [];

  const perVenue = await Promise.all(
    venues.map((v) => fetchPlansByVenue(v.id))
  );

  return perVenue.flat();
}

/**
 * Creates a new seating plan for a venue.
 * POST /api/seating-plans — Kong → venue-service.
 */
export async function createSeatingPlan(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const venueId = (formData.get("venueId") as string)?.trim();
  const name = (formData.get("name") as string)?.trim();
  const holdTtlRaw = (formData.get("holdTtlSec") as string)?.trim();
  const maxSeatsRaw = (formData.get("maxSeatsPerOrder") as string)?.trim();

  if (!venueId) return { error: "Venue ID is required." };
  if (!name) return { error: "Plan name is required." };

  const holdTtlSec = holdTtlRaw ? parseInt(holdTtlRaw, 10) : 300;
  const maxSeatsPerOrder = maxSeatsRaw ? parseInt(maxSeatsRaw, 10) : 10;

  const res = await fetch(`${base()}/api/seating-plans`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ venueId, name, holdTtlSec, maxSeatsPerOrder }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to create seating plan." };
  }

  const plan = await res.json();
  revalidatePath(`/venues/${venueId}`);
  redirect(`/venues/${venueId}/plans/${plan.id}`);
}

/**
 * Creates a new seating plan for a ticket with a venue as template.
 * Phase 3: ticket-first creation flow.
 * POST /api/seating-plans — Kong → venue-service.
 * 
 * This creates the plan with ticketId already set (no separate attach step).
 */
export async function createSeatingPlanForTicket(
  ticketId: string,
  venueId: string,
  planName: string,
  assignmentMode: "manual" | "auto",
  maxSeatsPerOrder?: number
): Promise<SeatingPlan | null> {
  if (!ticketId || !venueId || !planName) return null;

  const res = await fetch(`${base()}/api/seating-plans`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      ticketId,
      venueId,
      name: planName,
      assignmentMode,
      holdTtlSec: 300,
      maxSeatsPerOrder: maxSeatsPerOrder ?? 10,
    }),
  });

  if (!res.ok) {
    return null;
  }

  return res.json() as Promise<SeatingPlan>;
}

/**
 * Fetches sections for a seating plan.
 * GET /api/seating-plans/:planId — returns plan with sections array.
 * Used by ticket creation form for section pricing table.
 */
export async function fetchPlanSections(planId: string): Promise<import("@/lib/types").Section[]> {
  if (!planId) return [];
  const res = await fetch(`${base()}/api/seating-plans/${planId}`, {
    cache: "no-store",
    headers: await authHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.sections ?? []) as import("@/lib/types").Section[];
}

/**
 * Fetches all price tiers for a seating plan.
 * GET /api/seating-plans/:planId/price-tiers — Kong → venue-service.
 */
export async function fetchPriceTiers(planId: string): Promise<PriceTier[]> {
  const res = await fetch(`${base()}/api/seating-plans/${planId}/price-tiers`, {
    cache: "no-store",
    headers: await authHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.priceTiers ?? []) as PriceTier[];
}

/**
 * Creates a price tier inside a seating plan.
 * POST /api/seating-plans/:planId/price-tiers — Kong → venue-service.
 * 
 * venueId can be empty string when called from ticket-context (plan is already ticket-owned).
 * ticketId can be provided to redirect back to ticket plan page instead of venue plan page.
 */
export async function createPriceTier(
  planId: string,
  venueId: string,
  ticketId: string,
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const name = (formData.get("tierName") as string)?.trim();
  const price = (formData.get("tierPrice") as string)?.trim();

  if (!name) return { error: "Price tier name is required." };
  if (!price || isNaN(parseFloat(price)) || parseFloat(price) < 0) {
    return { error: "Price must be a valid non-negative number." };
  }

  const res = await fetch(`${base()}/api/seating-plans/${planId}/price-tiers`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ name, price }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to create price tier." };
  }

  // Redirect to ticket plan page if ticketId provided, otherwise to venue plan page
  if (ticketId) {
    revalidatePath(`/tickets/${ticketId}/plans/${planId}`);
    redirect(`/tickets/${ticketId}/plans/${planId}`);
  } else {
    revalidatePath(`/venues/${venueId}/plans/${planId}`);
    redirect(`/venues/${venueId}/plans/${planId}`);
  }
}

/**
 * Creates a section inside a seating plan.
 * POST /api/seating-plans/:planId/sections — Kong → venue-service.
 */
export async function createSection(
  planId: string,
  venueId: string,
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const name = (formData.get("name") as string)?.trim();
  const type = (formData.get("type") as string)?.trim();
  const rowCountRaw = (formData.get("rowCount") as string)?.trim();
  const columnCountRaw = (formData.get("columnCount") as string)?.trim();
  const priceTierId = (formData.get("priceTierId") as string)?.trim() ?? "";

  if (!name) return { error: "Section name is required." };
  if (type !== "seated" && type !== "ga") return { error: "Type must be 'seated' or 'ga'." };

  const rowCount = rowCountRaw ? parseInt(rowCountRaw, 10) : 0;
  const columnCount = columnCountRaw ? parseInt(columnCountRaw, 10) : 0;

  if (type === "seated" && (rowCount < 1 || columnCount < 1)) {
    return { error: "Row count and column count must each be at least 1 for seated sections." };
  }

  if (type === "ga" && columnCount < 1) {
    return { error: "GA sections must have a capacity of at least 1." };
  }

  const res = await fetch(`${base()}/api/seating-plans/${planId}/sections`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ name, type, rowCount, columnCount, priceTierId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to create section." };
  }

  revalidatePath(`/venues/${venueId}/plans/${planId}`);
  redirect(`/venues/${venueId}/plans/${planId}`);
}

/**
 * Saves the 2-D canvas layout blob for a draft seating plan.
 * PATCH /api/seating-plans/:planId/layout — Kong → venue-service.
 *
 * This is called from the SeatingPlanCanvas component on manual save or debounced
 * autosave. Only allowed while the plan is in 'draft' status.
 */
export async function saveLayout(
  planId: string,
  layoutJson: unknown
): Promise<PlanState> {
  if (!planId) return { error: "planId is required." };
  if (!layoutJson || typeof layoutJson !== "object") {
    return { error: "layoutJson must be an object." };
  }

  const res = await fetch(`${base()}/api/seating-plans/${planId}/layout`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify({ layoutJson }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to save layout." };
  }

  return {};
}

/**
 * Deactivates an active seating plan, stopping new purchases.
 * POST /api/seating-plans/:planId/deactivate — Kong → venue-service.
 * 
 * venueId can be empty string when called from ticket-context.
 * ticketId can be provided to redirect back to ticket plan page instead of venue plan page.
 */
export async function deactivatePlan(
  planId: string,
  venueId: string,
  ticketId: string,
  prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  void prev;
  void formData;

  if (!planId) return { error: "planId is required." };

  const res = await fetch(`${base()}/api/seating-plans/${planId}/deactivate`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to deactivate plan." };
  }

  // Redirect to ticket plan page if ticketId provided, otherwise to venue plan page
  if (ticketId) {
    revalidatePath(`/tickets/${ticketId}/plans/${planId}`);
    redirect(`/tickets/${ticketId}/plans/${planId}`);
  } else {
    revalidatePath(`/venues/${venueId}/plans/${planId}`);
    redirect(`/venues/${venueId}/plans/${planId}`);
  }
}

/**
 * Activates a draft seating plan.
 * POST /api/seating-plans/:planId/activate — Kong → venue-service.
 *
 * Pre-conditions (enforced by the service):
 *   - Plan must be in "draft" status.
 *   - Plan must have at least one section.
 * 
 * venueId can be empty string when called from ticket-context.
 * ticketId can be provided to redirect back to ticket plan page instead of venue plan page.
 */
export async function activatePlan(
  planId: string,
  venueId: string,
  ticketId: string,
  prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  void prev;
  void formData;

  if (!planId) return { error: "planId is required." };

  const res = await fetch(`${base()}/api/seating-plans/${planId}/activate`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to activate plan." };
  }

  // Redirect to ticket plan page if ticketId provided, otherwise to venue plan page
  if (ticketId) {
    revalidatePath(`/tickets/${ticketId}/plans/${planId}`);
    redirect(`/tickets/${ticketId}/plans/${planId}`);
  } else {
    revalidatePath(`/venues/${venueId}/plans/${planId}`);
    redirect(`/venues/${venueId}/plans/${planId}`);
  }
}

/**
 * Updates an existing venue.
 * PUT /api/venues/:id — Kong → venue-service.
 */
export async function updateVenue(
  venueId: string,
  prev: VenueState,
  formData: FormData
): Promise<VenueState> {
  void prev;

  const name = (formData.get("name") as string)?.trim();
  const capacityRaw = formData.get("capacity") as string;
  const capacity = parseInt(capacityRaw, 10);
  const timezone = (formData.get("timezone") as string)?.trim() ?? "";
  const address = (formData.get("address") as string)?.trim() ?? "";

  if (!name) return { error: "Name is required." };
  if (!capacityRaw || !Number.isFinite(capacity) || capacity < 1)
    return { error: "Capacity must be a positive number." };

  const res = await fetch(`${base()}/api/venues/${venueId}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ name, capacity, timezone, address }),
  });

  if (!res.ok) {
    if (res.status === 401) redirect("/auth/signin");
    const body = await res.json().catch(() => ({}));
    return { error: body?.error?.message ?? body?.message ?? "Failed to update venue." };
  }

  revalidatePath(`/venues/${venueId}`);
  revalidatePath("/venues");
  redirect(`/venues/${venueId}`);
}
