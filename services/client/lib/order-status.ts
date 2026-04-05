// lib/order-status.ts — Shared order status display config.
// Single source of truth for labels, badges, borders, and icons across all
// order-related pages. Import from here rather than redefining per page.

import type { Order } from "@/lib/types";

export const STATUS_LABEL: Record<Order["status"], string> = {
  created: "Created",
  awaiting_payment: "Awaiting Payment",
  cancelled: "Cancelled",
  complete: "Complete",
};

/** Tailwind classes for Badge background/text/border per status. */
export const STATUS_BADGE: Record<Order["status"], string> = {
  created: "bg-primary/10 text-primary border-primary/20 font-medium",
  awaiting_payment: "bg-amber-500/10 text-amber-700 border-amber-500/20 font-medium",
  cancelled: "bg-destructive/10 text-destructive border-destructive/20 font-medium",
  complete: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 font-medium",
};

/** Tailwind border-left color classes for order list cards. */
export const STATUS_BORDER: Record<Order["status"], string> = {
  created: "border-l-primary",
  awaiting_payment: "border-l-amber-500",
  cancelled: "border-l-destructive",
  complete: "border-l-emerald-500",
};
