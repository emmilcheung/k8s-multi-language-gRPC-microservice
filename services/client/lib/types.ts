// lib/types.ts — shared domain types consumed across pages and actions.

export interface User {
  id: string;
  email: string;
}

export interface Profile {
  id?: string;
  email?: string;
  displayName?: string;
  locale?: string;
  timezone?: string;
  fullName?: string;
  phone?: string;
}

export interface Preferences {
  marketingOptIn?: boolean;
  orderUpdates?: boolean;
  productUpdates?: boolean;
  locale?: string;
  currency?: string;
  marketingEmails?: boolean;
}

export interface BillingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  lastRotatedAt?: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  current: boolean;
}

export interface SavedPaymentMethod {
  id: string;
  brand?: string;
  label?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  isDefault?: boolean;
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
  available?: number;
  sold?: number;
  /** Maximum units a single buyer can reserve per order */
  maxPerUser?: number;
  /** CP-13: optional seating plan UUID — if set, this is a seated ticket */
  seatingPlanId?: string | null;
  /** WS3: Ticket type: "GA", "SEATED_MANUAL", or "SEATED_AUTO" */
  ticketType?: string;
  /** WS8: Optional event metadata including start date */
  event?: {
    title: string;
    description?: string;
    startsAt: string;
    endsAt?: string;
    imageUrl?: string;
    venueName?: string;
    venueAddress?: string;
  };
  version: number;
  createdAt?: string;
}

/** Seat state as returned by venue-service availability snapshot. */
export type SeatStatus = "available" | "held" | "reserved" | "sold" | "blocked";

/** Per-seat entry in the availability snapshot. */
export interface SeatAvailability {
  status: SeatStatus;
  /** Section this seat belongs to — used by the seat map to filter by active section tab. */
  sectionId: string;
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

/** A reusable seating layout template section attached to a venue (no inventory). */
export interface VenueSection {
  id: string;
  venueId: string;
  name: string;
  type: "seated" | "ga";
  rowCount: number;
  columnCount: number;
  positionJson: string;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** A price tier from venue-service GET /api/seating-plans/:id/price-tiers */
export interface PriceTier {
  id: string;
  planId: string;
  name: string;
  /** Decimal string, e.g. "75.00" */
  price: string;
  createdAt: string;
}

/** A seat section from venue-service GET /api/seating-plans/:id */
export interface Section {
  id: string;
  planId?: string;
  name: string;
  /** Matches the API field "type": "seated" | "ga" (lowercase). */
  type: "seated" | "ga";
  rowCount: number;
  /** For seated sections: number of columns per row. For GA sections: total capacity. */
  columnCount: number;
  /** Optional price tier assigned to the whole section. */
  priceTierId?: string;
}

/** Per-section node entry in the seating plan layout JSON blob. */
export interface LayoutNode {
  /** Matches a Section.id — used to correlate canvas position with the section record. */
  id: string;
  position: { x: number; y: number };
  data: {
    /**
     * rowOffsets maps row index (stringified) → x-pixel offset relative to the
     * section node's origin.  Used to stagger/curve rows in SEATED sections.
     */
    rowOffsets?: Record<string, number>;
  };
}

/** A seating plan from venue-service GET /api/seating-plans/:id */
export interface SeatingPlan {
  id: string;
  venueId: string;
  ticketId?: string | null;
  organizerId: string;
  name: string;
  status: "draft" | "active" | "inactive";
  maxSeatsPerOrder: number;
  /** Seller's choice of seat assignment mode: "manual" or "auto" */
  assignmentMode?: "manual" | "auto";
  /** How seat prices are determined: single flat price, per-section, or per-seat */
  pricingMode?: "single" | "section" | "seat";
  /**
   * layoutJson is the persisted canvas state for the drag-and-drop seating plan editor.
   * Populated by PATCH /api/seating-plans/:id/layout.
   */
  layoutJson?: {
    nodes: LayoutNode[];
    viewport?: { x: number; y: number; zoom: number };
  };
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
  quantity: number;
  seats?: Array<{
    seatId: string;
    sectionId: string;
    seatLabel: string;
    /** seat price returned as a decimal string */
    price: string;
  }>;
  version: number;
  subtotal?: string;
  serviceFee?: string;
  facilityFee?: string;
  tax?: string;
  total?: string;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  status: string;
}

export interface AttendanceSettings {
  eventId: string;
  requireQrForEntry: boolean;
  allowManualOverride: boolean;
}

export interface AttendanceSummary {
  eventId: string;
  totalAdmitted: number;
  totalDenied: number;
  totalCheckedIn: number;
}

export interface AttendanceCheckInItem {
  credentialId: string;
  ticketId: string;
  orderId: string;
  eventId: string;
  status: "ISSUED" | "USED" | "REVOKED" | "EXPIRED";
  buyerUserId?: string;
  checkedInAt?: string;
  checkedInByUserId?: string;
  checkedInByDeviceId?: string;
}

export interface AttendanceCheckInList {
  eventId: string;
  items: AttendanceCheckInItem[];
}

export interface UserLookupResponse {
  user: {
    id: string;
    email: string;
  };
}

export interface AdmissionPass {
  id: string;
  ticketId: string;
  orderId: string;
  eventId: string;
  status: "ISSUED" | "USED" | "REVOKED" | "EXPIRED";
  transferState?: "NONE" | "PENDING" | "ACCEPTED" | "RECALLED";
  transferredTo?: string;
  transferredAt?: string;
  issuedAt: string;
  usedAt?: string;
  qrToken?: string;
}

export type ScannerResultClass =
  | "valid"
  | "already_used"
  | "revoked"
  | "invalid_signature"
  | "wrong_event"
  | "not_found"
  | "policy_block";

export interface ScannerRequest {
  token: string;
  eventId: string;
  deviceId: string;
  gateId?: string;
}

export interface ScannerResponse {
  result: ScannerResultClass;
  credentialId?: string;
  eventId?: string;
  status?: "ISSUED" | "USED" | "REVOKED" | "EXPIRED";
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; issue: string }[];
  };
}
