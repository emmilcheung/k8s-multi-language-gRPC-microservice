// app/orders/page.tsx — My Orders list (authenticated Server Component).
// Status-aware cards with left-border accent and clear visual hierarchy.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/api";
import type { Order } from "@/lib/types";
import { STATUS_LABEL, STATUS_BADGE, STATUS_BORDER } from "@/lib/order-status";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  CircleDot,
  ShoppingBag,
  Ticket,
} from "lucide-react";

export const metadata = { title: "My Orders — Ticketing" };

function orderTotal(order: Order): number {
  const seatTotal = (order.seats ?? []).reduce((sum, seat) => sum + parseFloat(seat.price), 0);
  if (seatTotal > 0) return seatTotal;
  return parseFloat(order.ticket.price) * Math.max(1, order.quantity ?? 1);
}

const STATUS_ICON: Record<Order["status"], React.ReactNode> = {
  created: <CircleDot className="w-3.5 h-3.5" />,
  awaiting_payment: <Clock className="w-3.5 h-3.5" />,
  cancelled: <XCircle className="w-3.5 h-3.5" />,
  complete: <CheckCircle2 className="w-3.5 h-3.5" />,
};

async function getOrders(): Promise<Order[]> {
  try {
    return await serverApi<Order[]>("/api/orders");
  } catch {
    return [];
  }
}

export default async function OrdersPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  const orders = await getOrders();

  return (
    <div className="flex flex-col gap-8">
      {/* Heading */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">My Orders</h1>
        <p className="text-sm text-muted-foreground">
          {orders.length > 0
            ? `${orders.length} order${orders.length !== 1 ? "s" : ""} found`
            : "No orders yet"}
        </p>
      </div>

      {orders.length === 0 ? (
        /* Empty state */
        <div className="glass rounded-2xl flex flex-col items-center gap-4 py-20 px-8 text-center">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 ring-1 ring-primary/20">
            <ShoppingBag className="w-8 h-8 text-primary/60" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-lg">No orders yet</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Browse available tickets and make your first purchase.
            </p>
          </div>
          <Link
            href="/"
            className={cn(
              buttonVariants(),
              "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground mt-2"
            )}
          >
            <Ticket className="w-4 h-4" />
            Browse Tickets
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orders.map((order) => (
            <div
              key={order.id}
              className={cn(
                "glass rounded-2xl border-l-4 flex flex-col gap-4 p-5",
                STATUS_BORDER[order.status]
              )}
            >
              {/* Title + price */}
              <div className="flex flex-col gap-1">
                <p className="font-semibold leading-snug line-clamp-2 text-sm">
                  {order.ticket.title}
                </p>
                <p className="text-xl font-bold">${orderTotal(order).toFixed(2)}</p>
              </div>

              {/* Status badge */}
              <Badge
                className={cn(
                  "inline-flex items-center gap-1.5 w-fit text-xs font-medium",
                  STATUS_BADGE[order.status]
                )}
              >
                {STATUS_ICON[order.status]}
                {STATUS_LABEL[order.status]}
              </Badge>

              {/* Expiry warning */}
              {order.status === "awaiting_payment" && (
                <p className="text-xs text-amber-400/80 flex items-center gap-1.5">
                  <Clock className="w-3 h-3 shrink-0" />
                  Expires {new Date(order.expiresAt).toLocaleString()}
                </p>
              )}

              {/* View link */}
              <Link
                href={`/orders/${order.id}`}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1 text-muted-foreground hover:text-foreground mt-auto -ml-2 self-start"
                )}
              >
                View order
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
