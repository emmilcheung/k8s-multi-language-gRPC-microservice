"use server";
// app/actions/venues.ts — Server Actions for venue and seating-plan mutations.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { executeQuery, executeMutation } from "@/lib/graphql/execute";
import { base, authHeaders } from "@/lib/server-utils";
import type { SeatingPlan, PriceTier, VenueSection, Section } from "@/lib/types";
import {
  VenuesListDocument,
  VenueDetailDocument,
  CreateVenueDocument,
  UpdateVenueDocument,
  CreateVenueSectionDocument,
  UpdateVenueSectionDocument,
  ActivateSeatingPlanDocument,
  DeactivateSeatingPlanDocument,
  CreatePriceTierDocument,
  CreateSeatingPlanDocument,
  UpdateSeatingPlanDocument,
} from "@/lib/graphql/generated";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface Venue {
  id: string;
  organizerId: string;
  name: string;
  capacity: number;
  timezone: string;
  address: string;
}

export interface VenueState {
  error?: string;
}

export interface PlanState {
  error?: string;
  refreshed?: true;
}

const PLAN_STATUS_RETRY_DELAYS_MS = [100, 200, 400, 800];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForPlanStatus(planId: string, expectedStatus: SeatingPlan["status"]): Promise<void> {
  const headers = await authHeaders();

  for (let attempt = 0; attempt <= PLAN_STATUS_RETRY_DELAYS_MS.length; attempt += 1) {
    const res = await fetch(`${base()}/api/seating-plans/${planId}`, {
      method: "GET",
      cache: "no-store",
      headers,
    });

    if (!res.ok) {
      throw new Error(`Failed to verify seating plan state (${res.status}).`);
    }

    const plan = await res.json() as SeatingPlan;
    if (plan.status === expectedStatus) {
      return;
    }

    if (attempt === PLAN_STATUS_RETRY_DELAYS_MS.length) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, PLAN_STATUS_RETRY_DELAYS_MS[attempt]));
  }

  throw new Error(`Seating plan did not reach ${expectedStatus} state in time.`);
}

// ─── Venue queries ────────────────────────────────────────────────────────────

/**
 * Fetches all venues belonging to the authenticated organizer via GraphQL.
 */
export async function fetchMyVenues() {
  try {
    const data = await executeQuery(VenuesListDocument, {});
    return data.venues;
  } catch {
    return [];
  }
}

/**
 * Fetches a single venue by ID via GraphQL.
 */
export async function fetchVenue(venueId: string) {
  try {
    const data = await executeQuery(VenueDetailDocument, { id: venueId });
    return data.venue;
  } catch {
    return null;
  }
}

// ─── Venue mutations ──────────────────────────────────────────────────────────

/**
 * Creates a new venue via GraphQL.
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

  try {
    const data = await executeMutation(CreateVenueDocument, {
      input: { name, capacity, timezone, address: address || undefined },
    });
    revalidatePath("/venues");
    redirect(`/venues/${data.createVenue.id}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to create venue." };
  }
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
 * Adds a template section to a venue via GraphQL.
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

  const gqlType = type === "ga" ? "GA" : "SEATED";

  try {
    await executeMutation(CreateVenueSectionDocument, {
      venueId,
      input: { name, type: gqlType, rowCount: rowCount || undefined, columnCount },
    });
    revalidatePath(`/venues/${venueId}`);
    redirect(`/venues/${venueId}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to add section." };
  }
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

// ─── Seating plan queries ─────────────────────────────────────────────────────

/**
 * Fetches all seating plans for a given venue.
 * GET /api/seating-plans?venueId=... — Kong → venue-service.
 *
 * Stays as REST: GraphQL SeatingPlan type lacks name/maxSeatsPerOrder/ticketId.
 */
export async function fetchPlansByVenue(venueId: string): Promise<SeatingPlan[]> {
  const url = new URL(`${base()}/api/seating-plans`);
  url.searchParams.set("venueId", venueId);

  const res = await fetch(url.toString(), {
    cache: "no-store",
    headers: await authHeaders(),
  });

  if (!res.ok) return [];

  const data = await res.json();
  if (Array.isArray(data)) return data as SeatingPlan[];
  return (data?.plans ?? []) as SeatingPlan[];
}

/**
 * Fetches all seating plans across all organizer venues.
 * Used by ticket detail page to populate "Attach seating plan" dropdown.
 *
 * Stays as REST: GraphQL SeatingPlan type lacks name/maxSeatsPerOrder/ticketId.
 */
export async function fetchAllMyPlans(): Promise<SeatingPlan[]> {
  const venues = await fetchMyVenues();
  if (venues.length === 0) return [];

  const perVenue = await Promise.all(
    venues.map((v) => fetchPlansByVenue(v.id))
  );

  return perVenue.flat();
}

// ─── Seating plan mutations ───────────────────────────────────────────────────

/**
 * Creates a new seating plan for a venue (venue-context, no ticketId).
 * POST /api/seating-plans — Kong → venue-service.
 *
 * Stays as REST: GraphQL createSeatingPlan requires ticketId.
 */
export async function createSeatingPlan(
  _prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  const venueId = (formData.get("venueId") as string)?.trim();
  const name = (formData.get("name") as string)?.trim();
  const maxSeatsRaw = (formData.get("maxSeatsPerOrder") as string)?.trim();

  if (!venueId) return { error: "Venue ID is required." };
  if (!name) return { error: "Plan name is required." };

  const maxSeatsPerOrder = maxSeatsRaw ? parseInt(maxSeatsRaw, 10) : 10;

  const res = await fetch(`${base()}/api/seating-plans`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ venueId, name, maxSeatsPerOrder }),
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
 * Creates a new seating plan for a ticket with a venue as template via GraphQL.
 * Phase 3: ticket-first creation flow with ticketId pre-set.
 */
export async function createSeatingPlanForTicket(
  ticketId: string,
  venueId: string,
  planName: string,
  assignmentMode: "manual" | "auto",
  maxSeatsPerOrder?: number,
  pricingMode?: "single" | "section" | "seat"
): Promise<{ id: string } | null> {
  if (!ticketId || !venueId || !planName) return null;

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const data = await executeMutation(CreateSeatingPlanDocument, {
        input: {
          ticketId,
          venueId,
          name: planName,
          assignmentMode: assignmentMode === "auto" ? "AUTO" : "MANUAL",
          maxSeatsPerOrder: maxSeatsPerOrder ?? 10,
          pricingMode: pricingMode ?? undefined,
        },
      });
      return { id: data.createSeatingPlan.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const isNotFound = message.toLowerCase().includes("not found");
      if (!isNotFound || attempt === 8) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return null;
}

/**
 * Fetches sections for a seating plan.
 * GET /api/seating-plans/:planId — returns plan with sections array.
 */
export async function fetchPlanSections(planId: string): Promise<Section[]> {
  if (!planId) return [];
  const res = await fetch(`${base()}/api/seating-plans/${planId}`, {
    cache: "no-store",
    headers: await authHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.sections ?? []) as Section[];
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
 * Creates a price tier inside a seating plan via GraphQL.
 *
 * venueId can be empty string when called from ticket-context.
 * ticketId can be provided to redirect back to ticket plan page.
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

  try {
    await executeMutation(CreatePriceTierDocument, {
      planId,
      input: { name, price },
    });

    if (ticketId) {
      revalidatePath(`/tickets/${ticketId}/plans/${planId}`);
      redirect(`/tickets/${ticketId}/plans/${planId}`);
    } else {
      revalidatePath(`/venues/${venueId}/plans/${planId}`);
      redirect(`/venues/${venueId}/plans/${planId}`);
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to create price tier." };
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
 * Deactivates an active seating plan via GraphQL.
 *
 * venueId can be empty string when called from ticket-context.
 * ticketId can be provided to redirect back to ticket plan page.
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

  try {
    await executeMutation(DeactivateSeatingPlanDocument, { id: planId });
    await waitForPlanStatus(planId, "inactive");
    if (ticketId) {
      revalidatePath(`/tickets/${ticketId}/plans/${planId}`, "layout");
      revalidatePath(`/tickets/${ticketId}`);
      revalidatePath("/");
      redirect(`/tickets/${ticketId}/plans/${planId}`);
    }

    revalidatePath(`/venues/${venueId}/plans/${planId}`, "layout");
    revalidatePath(`/venues/${venueId}`);
    redirect(`/venues/${venueId}/plans/${planId}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to deactivate plan." };
  }
}

/**
 * Activates a draft seating plan via GraphQL.
 *
 * Pre-conditions (enforced by the service):
 *   - Plan must be in "draft" status.
 *   - Plan must have at least one section.
 *
 * venueId can be empty string when called from ticket-context.
 * ticketId can be provided to redirect back to ticket plan page.
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

  try {
    await executeMutation(ActivateSeatingPlanDocument, { id: planId });
    await waitForPlanStatus(planId, "active");
    if (ticketId) {
      revalidatePath(`/tickets/${ticketId}/plans/${planId}`, "layout");
      revalidatePath(`/tickets/${ticketId}`);
      revalidatePath("/");
      redirect(`/tickets/${ticketId}/plans/${planId}`);
    }

    revalidatePath(`/venues/${venueId}/plans/${planId}`, "layout");
    revalidatePath(`/venues/${venueId}`);
    redirect(`/venues/${venueId}/plans/${planId}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to activate plan." };
  }
}

/**
 * Updates an existing venue via GraphQL.
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

  try {
    await executeMutation(UpdateVenueDocument, {
      id: venueId,
      input: { name, capacity, timezone, address: address || undefined },
    });

    revalidatePath(`/venues/${venueId}`);
    revalidatePath("/venues");
    redirect(`/venues/${venueId}`);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return { error: error instanceof Error ? error.message : "Failed to update venue." };
  }
}

export async function updateSeatingPlan(
  planId: string,
  prev: PlanState,
  formData: FormData
): Promise<PlanState> {
  void prev;

  const name = (formData.get("name") as string)?.trim();
  const maxSeatsPerOrderRaw = formData.get("maxSeatsPerOrder") as string;
  const maxSeatsPerOrder = maxSeatsPerOrderRaw ? parseInt(maxSeatsPerOrderRaw, 10) : undefined;

  try {
    await executeMutation(UpdateSeatingPlanDocument, {
      id: planId,
      input: {
        name: name || undefined,
        maxSeatsPerOrder: maxSeatsPerOrder ?? undefined,
      },
    });
    revalidatePath(`/venues`);
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to update seating plan." };
  }
}

export async function updateVenueSection(
  sectionId: string,
  prev: VenueState,
  formData: FormData
): Promise<VenueState> {
  void prev;

  const name = (formData.get("name") as string)?.trim();
  const rowCountRaw = formData.get("rowCount") as string;
  const columnCountRaw = formData.get("columnCount") as string;
  const rowCount = rowCountRaw ? parseInt(rowCountRaw, 10) : undefined;
  const columnCount = columnCountRaw ? parseInt(columnCountRaw, 10) : undefined;

  try {
    await executeMutation(UpdateVenueSectionDocument, {
      id: sectionId,
      input: {
        name: name || undefined,
        rowCount: rowCount ?? undefined,
        columnCount: columnCount ?? undefined,
      },
    });
    revalidatePath("/venues");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to update venue section." };
  }
}
