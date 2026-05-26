// app/orders/page.tsx — My Orders list (authenticated Server Component).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { OrdersPageDocument } from "@/lib/graphql/generated";
import { executeQuery } from "@/lib/graphql/execute";
import type { Order } from "@/lib/types";
import { STATUS_LABEL, STATUS_BADGE, STATUS_BORDER, coerceOrderStatus } from "@/lib/order-status";
import { calculateOrderTotal } from "@/lib/order-utils";
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

export const metadata = { title: "My Orders — Marquee" };

const STATUS_ICON: Record<Order["status"], React.ReactNode> = {
  created: <CircleDot className="size-3.5" />,
  awaiting_payment: <Clock className="size-3.5" />,
  cancelled: <XCircle className="size-3.5" />,
  complete: <CheckCircle2 className="size-3.5" />,
};

async function getOrders(): Promise<Order[]> {
  try {
    const data = await executeQuery(OrdersPageDocument, {}, { cookie: (await cookies()).toString() });
    return data.orders.map((order) => ({
      id: order.id,
      userId: order.userId,
      status: coerceOrderStatus(order.status),
      quantity: order.quantity,
      expiresAt: order.expiresAt ?? "",
      ticket: {
        id: order.ticket.id,
        title: order.ticket.title,
        price: order.ticket.price,
      },
      version: 0,
    }));
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
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      {/* Heading */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-primary" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            My Orders
          </span>
        </div>
        <h1 className="font-display font-extrabold text-2xl tracking-tight">My Orders</h1>
        <p className="text-sm text-muted-foreground">
          {orders.length > 0
            ? `${orders.length} order${orders.length !== 1 ? "s" : ""}`
            : "No orders yet"}
        </p>
      </div>

      {orders.length === 0 ? (
        <div className="border border-border rounded bg-card flex flex-col items-center gap-5 py-20 px-8 text-center">
          <div className="flex items-center justify-center size-14 rounded bg-muted">
            <ShoppingBag className="size-7 text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-display font-bold text-lg">No orders yet</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Browse available tickets and make your first purchase.
            </p>
          </div>
          <Link
            href="/"
            className={cn(buttonVariants(), "gap-2 bg-primary hover:bg-primary/90 text-primary-foreground")}
          >
            <Ticket className="size-4" />
            Browse Tickets
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orders.map((order) => (
            <div
              key={order.id}
              className={cn(
                "bg-card border border-border border-l-[3px] rounded overflow-hidden flex flex-col gap-4 p-5",
                STATUS_BORDER[order.status]
              )}
            >
              {/* Title + price */}
              <div className="flex flex-col gap-0.5">
                <p className="font-display font-bold text-sm leading-snug line-clamp-2">
                  {order.ticket.title}
                </p>
                <p className="font-display font-extrabold text-xl">
                  ${calculateOrderTotal(order).toFixed(2)}
                </p>
              </div>

              {/* Status badge */}
              <Badge
                className={cn(
                  "inline-flex items-center gap-1.5 w-fit text-xs rounded",
                  STATUS_BADGE[order.status]
                )}
              >
                {STATUS_ICON[order.status]}
                {STATUS_LABEL[order.status]}
              </Badge>

              {/* Expiry warning */}
              {order.status === "awaiting_payment" && (
                <p className="text-xs text-amber-700 flex items-center gap-1.5">
                  <Clock className="size-3 shrink-0" />
                  Expires {new Date(order.expiresAt).toLocaleString()}
                </p>
              )}

              {/* View link */}
              <Link
                href={`/orders/${order.id}`}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "gap-1 text-muted-foreground hover:text-foreground mt-auto -ml-2 self-start text-xs"
                )}
              >
                View order
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
