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
  version: number;
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
