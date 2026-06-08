import type { Order } from "@/lib/types";

export function calculateOrderTotal(order: Order): number {
  if (order.total != null) return parseFloat(order.total);
  const seatTotal = (order.seats ?? []).reduce((sum, seat) => sum + parseFloat(seat.price), 0);
  if (seatTotal > 0) return seatTotal;
  return parseFloat(order.ticket.price) * Math.max(1, order.quantity ?? 1);
}
