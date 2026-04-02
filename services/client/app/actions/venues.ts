"use server";
// app/actions/venues.ts — Server Actions for venue and seating-plan mutations.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { base, authHeaders } from "@/lib/server-utils";
import type { SeatingPlan } from "@/lib/types";

// ─── Venue types ─────────────────────────────────────────────────────────────

export interface Venue {
  id: string;
  organizerId: string;
  name: string;
  capacity: number;
  timezone: string;
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

  if (!name) return { error: "Venue name is required." };

  const capacity = parseInt(capacityRaw, 10);
  if (!capacityRaw || !Number.isFinite(capacity) || capacity < 1) {
    return { error: "Capacity must be a positive integer." };
  }

  if (!timezone) return { error: "Timezone is required." };

  const res = await fetch(`${base()}/api/venues`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ name, capacity, timezone }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { error: body?.error ?? "Failed to create venue." };
  }

  const venue = await res.json();
  revalidatePath("/venues");
  redirect(`/venues/${venue.id}`);
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

  if (!name) return { error: "Section name is required." };
  if (type !== "seated" && type !== "ga") return { error: "Type must be 'seated' or 'ga'." };

  const rowCount = rowCountRaw ? parseInt(rowCountRaw, 10) : 0;
  const columnCount = columnCountRaw ? parseInt(columnCountRaw, 10) : 0;

  if (type === "seated" && (rowCount < 1 || columnCount < 1)) {
    return { error: "Row count and column count must each be at least 1 for seated sections." };
  }

  const res = await fetch(`${base()}/api/seating-plans/${planId}/sections`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ name, type, rowCount, columnCount }),
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
