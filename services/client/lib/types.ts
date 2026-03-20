// lib/types.ts — shared domain types consumed across pages and actions.

export interface User {
  id: string;
  email: string;
}

export interface Ticket {
  id: string;
  title: string;
  price: number;
  userId: string;
  orderId?: string | null;
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
    price: number;
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
