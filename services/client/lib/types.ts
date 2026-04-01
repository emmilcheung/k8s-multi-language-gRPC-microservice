// lib/types.ts — shared domain types consumed across pages and actions.

export interface User {
  id: string;
  email: string;
}

export interface Ticket {
  id: string;
  title: string;
  /** ticket-service returns price as a decimal string (e.g. "25.00") */
  price: string;
  userId: string;
  orderId?: string | null;
  /** GA quota fields — number of units currently reserved (active reservations) */
  reserved?: number;
  quota?: number;
  sold?: number;
  /** CP-13: optional seating plan UUID — if set, this is a seated ticket */
  seatingPlanId?: string | null;
  version: number;
}

/** Seat state as returned by venue-service availability snapshot. */
export type SeatStatus = "available" | "held" | "reserved" | "sold" | "blocked";

/** Per-seat entry in the availability snapshot. */
export interface SeatAvailability {
  status: SeatStatus;
}

/** Availability snapshot returned by GET /api/seating-plans/:planId/availability */
export interface AvailabilitySnapshot {
  planId: string;
  seatMap: Record<string, SeatAvailability>;
  counts: {
    available: number;
    held: number;
    reserved: number;
    sold: number;
    blocked: number;
  };
  cachedAt: string;
}

/** A seat section from venue-service GET /api/seating-plans/:id */
export interface Section {
  id: string;
  name: string;
  sectionType: "SEATED" | "GA";
  rowCount: number;
  seatsPerRow: number;
  capacity: number;
}

/** A seating plan from venue-service GET /api/seating-plans/:id */
export interface SeatingPlan {
  id: string;
  venueId: string;
  ticketId?: string | null;
  organizerId: string;
  name: string;
  status: "draft" | "active" | "inactive";
  holdTtlSec: number;
  maxSeatsPerOrder: number;
  version: number;
  sections?: Section[];
}

export interface Order {
  id: string;
  userId: string;
  status: "created" | "awaiting_payment" | "cancelled" | "complete";
  expiresAt: string;
  ticket: {
    id: string;
    title: string;
    /** ticket price returned as a decimal string from ticket-service */
    price: string;
  };
  version: number;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  status: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; issue: string }[];
  };
}
