"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Calendar,
  Clock3,
  CreditCard,
  MapPin,
  ShoppingBag,
  Ticket,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Stat } from "@/components/system";
import { buttonVariants } from "@/components/ui/button-variants";
import { calculateOrderTotal } from "@/lib/order-utils";
import { cn } from "@/lib/utils";
import type { Order } from "@/lib/types";

export type OrdersOverviewOrder = Order & {
  event?: {
    title?: string;
    startsAt?: string;
    venueName?: string;
    venueAddress?: string;
  };
  seatingPlanId?: string | null;
};

type OrdersTab = "upcoming" | "past" | "saved" | "refunded";

type OrdersOverviewProps = {
  orders: OrdersOverviewOrder[];
};

const TAB_LABELS: Record<OrdersTab, string> = {
  upcoming: "Upcoming",
  past: "Past",
  saved: "Saved",
  refunded: "Refunded",
};

function formatEventDate(value?: string): string {
  if (!value) return "Date to be confirmed";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getOrderPhase(order: OrdersOverviewOrder, now: Date): OrdersTab {
  if (order.status === "cancelled") return "past";

  const startsAt = order.event?.startsAt ? new Date(order.event.startsAt) : null;
  if (startsAt && startsAt < now) {
    return "past";
  }

  if (order.status === "complete" || order.status === "awaiting_payment" || order.status === "created") {
    return "upcoming";
  }

  return "past";
}

function getStatusBadge(order: OrdersOverviewOrder, tab: OrdersTab) {
  if (order.status === "awaiting_payment" || order.status === "created") {
    return { label: "Pay now", tone: "warn" as const, dot: true };
  }

  if (order.status === "cancelled") {
    return { label: "Cancelled", tone: "neutral" as const, dot: false };
  }

  if (tab === "past") {
    return { label: "Attended", tone: "neutral" as const, dot: false };
  }

  return { label: "Ready", tone: "ok" as const, dot: true };
}

function InlineHoldTimer({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  const remainingMs = new Date(expiresAt).getTime() - now;
  if (remainingMs <= 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums text-bad">
        <Clock3 className="size-3.5" />
        Hold expired
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums text-warn">
      <Clock3 className="size-3.5" />
      {formatDuration(remainingMs)}
    </span>
  );
}

function EmptyOrdersCard() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-5 px-8 py-14 text-center">
        <div className="relative flex size-20 items-center justify-center rounded-2xl border border-dashed border-line bg-subtle text-mute">
          <Ticket className="size-8" />
          <span className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border border-line bg-card text-accent">
            <ArrowRight className="size-3.5" />
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-ink">No upcoming orders</h2>
          <p className="max-w-md text-sm leading-6 text-mute">
            When you buy a ticket, it&apos;ll show up here with your seat info, transfer options,
            and a mobile pass.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/" className={cn(buttonVariants({ variant: "primary" }), "gap-2")}>
            Browse tonight&apos;s shows
            <ArrowRight className="size-4" />
          </Link>
          <button type="button" className={buttonVariants({ variant: "ghost" })}>
            View saved events
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function PlaceholderTab({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-8 py-14 text-center">
        <ShoppingBag className="size-10 text-mute" />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <p className="max-w-md text-sm text-mute">{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderRow({ order, tab }: { order: OrdersOverviewOrder; tab: OrdersTab }) {
  const total = calculateOrderTotal(order);
  const statusBadge = getStatusBadge(order, tab);
  const displayTitle = order.event?.title?.trim() || order.ticket.title;
  const actionHref =
    order.status === "complete"
      ? `/tickets/${order.ticket.id}/admission?orderId=${order.id}`
      : `/orders/${order.id}`;
  const actionLabel =
    order.status === "complete" ? "Open pass" : order.status === "cancelled" ? "View order" : `Pay ${formatCurrency(total)}`;

  return (
    <Card className="overflow-hidden py-0">
      <div className="flex flex-col border-l border-l-transparent md:flex-row">
        <div className="h-24 bg-[linear-gradient(135deg,oklch(0.35_0.08_280),oklch(0.58_0.18_285)_60%,oklch(0.69_0.16_330))] md:h-auto md:w-28" />
        <CardContent className="flex flex-1 flex-col gap-4 px-5 py-5 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusBadge.tone} dot={statusBadge.dot}>
                {statusBadge.label}
              </Badge>
              {(order.status === "awaiting_payment" || order.status === "created") && order.expiresAt && (
                <InlineHoldTimer expiresAt={order.expiresAt} />
              )}
              <span className="text-xs font-mono text-mute">#{order.id}</span>
            </div>
            <div className="space-y-1">
              <h3 className="truncate text-base font-semibold tracking-tight text-ink">
                {displayTitle}
              </h3>
              <div className="flex flex-col gap-1 text-sm text-mute md:flex-row md:flex-wrap md:items-center md:gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="size-3.5" />
                  {formatEventDate(order.event?.startsAt)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="size-3.5" />
                  {order.event?.venueName ?? "Venue details on event page"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Ticket className="size-3.5" />
                  {order.quantity} {order.quantity === 1 ? "seat" : "seats"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-start gap-3 md:items-end">
            <div className="text-right">
              <div className="font-mono text-xl font-semibold text-ink">{formatCurrency(total)}</div>
              <div className="text-xs text-mute">{order.quantity} {order.quantity === 1 ? "ticket" : "tickets"}</div>
            </div>
            <Link href={actionHref} className={cn(buttonVariants({ variant: "primary", size: "sm" }), "gap-2")}>
              {order.status === "complete" ? <Ticket className="size-3.5" /> : <CreditCard className="size-3.5" />}
              {actionLabel}
            </Link>
          </div>
        </CardContent>
      </div>
    </Card>
  );
}

export function OrdersOverview({ orders }: OrdersOverviewProps) {
  const [activeTab, setActiveTab] = useState<OrdersTab>("upcoming");

  const tabbedOrders = useMemo(() => {
    const now = new Date();
    const grouped = {
      upcoming: [] as OrdersOverviewOrder[],
      past: [] as OrdersOverviewOrder[],
      saved: [] as OrdersOverviewOrder[],
      refunded: [] as OrdersOverviewOrder[],
    };

    for (const order of orders) {
      grouped[getOrderPhase(order, now)].push(order);
    }

    grouped.upcoming.sort((left, right) => {
      const leftTime = left.event?.startsAt ? new Date(left.event.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.event?.startsAt ? new Date(right.event.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });
    grouped.past.sort((left, right) => {
      const leftTime = left.event?.startsAt ? new Date(left.event.startsAt).getTime() : 0;
      const rightTime = right.event?.startsAt ? new Date(right.event.startsAt).getTime() : 0;
      return rightTime - leftTime;
    });

    return grouped;
  }, [orders]);

  const allCompletedOrders = orders.filter((order) => order.status === "complete");
  const totalSpent = allCompletedOrders.reduce((sum, order) => sum + calculateOrderTotal(order), 0);
  const averagePerShow = allCompletedOrders.length > 0 ? totalSpent / allCompletedOrders.length : 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          Tickets &amp; orders
        </span>
        <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.022em] text-ink">My orders</h1>
            <p className="text-sm text-mute">
              {orders.length > 0 ? `${orders.length} order${orders.length === 1 ? "" : "s"} in your history` : "No orders yet"}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-4">
        <Card size="sm">
          <CardContent>
            <Stat label="Upcoming" value={String(tabbedOrders.upcoming.length)} sub="active holds and ready passes" />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent>
            <Stat label="Spent this year" value={formatCurrency(totalSpent)} sub="completed orders" />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent>
            <Stat label="Avg. per show" value={formatCurrency(averagePerShow)} />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent>
            <Stat label="Saved events" value="0" sub="coming in Phase 7" />
          </CardContent>
        </Card>
      </div>

      <div className="border-b border-line">
        <div role="tablist" aria-label="Orders tabs" className="flex flex-wrap gap-2">
          {(["upcoming", "past", "saved", "refunded"] as OrdersTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-1 py-3 text-sm transition-colors",
                activeTab === tab
                  ? "border-ink font-semibold text-ink"
                  : "border-transparent font-medium text-mute hover:text-ink"
              )}
              onClick={() => setActiveTab(tab)}
            >
              {TAB_LABELS[tab]}
              <span className="font-mono text-xs text-mute">{tabbedOrders[tab].length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {activeTab === "upcoming" && tabbedOrders.upcoming.length === 0 && <EmptyOrdersCard />}
        {activeTab === "saved" && (
          <PlaceholderTab
            title="Saved events are on the way"
            description="Save events to come back to them. This tab stays intentionally empty until Phase 7."
          />
        )}
        {activeTab === "refunded" && (
          <PlaceholderTab
            title="No refunded orders yet"
            description="Refund history is wired in a later phase, so this tab stays empty for now."
          />
        )}
        {(activeTab === "upcoming" || activeTab === "past") &&
          tabbedOrders[activeTab].map((order) => (
            <OrderRow key={order.id} order={order} tab={activeTab} />
          ))}
      </div>
    </div>
  );
}
