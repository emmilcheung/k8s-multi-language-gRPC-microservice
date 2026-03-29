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
  created: "bg-primary/15 text-primary border-primary/25",
  awaiting_payment: "bg-amber-400/10 text-amber-400 border-amber-400/25",
  cancelled: "bg-destructive/10 text-destructive border-destructive/25",
  complete: "bg-emerald-400/10 text-emerald-400 border-emerald-400/25",
};

/** Tailwind border-left color classes for order list cards. */
export const STATUS_BORDER: Record<Order["status"], string> = {
  created: "border-l-primary/60",
  awaiting_payment: "border-l-amber-400/60",
  cancelled: "border-l-destructive/60",
  complete: "border-l-emerald-400/60",
};
