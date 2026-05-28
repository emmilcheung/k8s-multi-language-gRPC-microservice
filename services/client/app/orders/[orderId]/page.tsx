// app/orders/[orderId]/page.tsx — Order detail + payment form.
// Horizontal status stepper + split detail / payment layout.

import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { executeQuery } from "@/lib/graphql/execute";
import { OrderPageDocument } from "@/lib/graphql/generated";
import type { Order, SavedPaymentMethod } from "@/lib/types";
import { STATUS_LABEL, STATUS_BADGE, coerceOrderStatus } from "@/lib/order-status";
import { calculateOrderTotal } from "@/lib/order-utils";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { OrderPaymentForm } from "@/components/order-payment-form";
import { Card, CardContent } from "@/components/ui/card";
import { HoldTimerRibbon, Divider } from "@/components/system";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  CircleDot,
  Clock,
  CheckCircle2,
  XCircle,
  Ticket,
  DollarSign,
} from "lucide-react";

interface Props {
  params: Promise<{ orderId: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { orderId } = await params;
  return { title: `Order ${orderId.slice(0, 8)} — Ticketing` };
}

async function getOrderPageData(
  orderId: string,
  cookie: string,
): Promise<{ order: Order | null; savedPaymentMethods: SavedPaymentMethod[] }> {
  const data = await executeQuery(OrderPageDocument, { id: orderId }, { cookie });
  const raw = data.order;
  return {
    order: raw
      ? {
          id: raw.id,
          userId: raw.userId,
          status: coerceOrderStatus(raw.status),
          quantity: raw.quantity,
          expiresAt: raw.expiresAt ?? "",
          ticket: { id: raw.ticket.id, title: raw.ticket.title, price: raw.ticket.price },
          seats: raw.seats?.map((s) => ({
            seatId: s.seatId,
            sectionId: s.sectionId,
            seatLabel: s.seatLabel,
            price: s.price,
          })),
          version: 0,
        }
      : null,
    savedPaymentMethods: (data.currentUser?.paymentMethods ?? []).map((method) => ({
      id: method.id,
      brand: method.brand ?? undefined,
      label: method.label ?? undefined,
      last4: method.last4 ?? undefined,
      expMonth: method.expMonth ?? undefined,
      expYear: method.expYear ?? undefined,
      isDefault: method.isDefault ?? undefined,
    })),
  };
}

// Steps for the stepper (linear happy path — cancelled shown differently)
const STEPS: { key: Order["status"]; label: string; icon: React.ReactNode }[] = [
  { key: "created", label: "Order Created", icon: <CircleDot className="w-4 h-4" /> },
  { key: "awaiting_payment", label: "Awaiting Payment", icon: <Clock className="w-4 h-4" /> },
  { key: "complete", label: "Complete", icon: <CheckCircle2 className="w-4 h-4" /> },
];

const STEP_ORDER: Record<Order["status"], number> = {
  created: 0,
  awaiting_payment: 1,
  cancelled: -1,
  complete: 2,
};

// Seat labels come as "R12S5" (row 12, seat 5) or letter-row "A12".
function parseSeatLabel(label: string): { row: string; seat: string } {
  const rs = label.match(/^R(\d+)S(\d+)$/i);
  if (rs) return { row: rs[1], seat: rs[2] };
  const ls = label.match(/^([A-Za-z]+)(\d+)$/);
  if (ls) return { row: ls[1], seat: ls[2] };
  return { row: label, seat: "" };
}

export default async function OrderDetailPage({ params }: Props) {
  const { orderId } = await params;

  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  let order: Order;
  let savedPaymentMethods: SavedPaymentMethod[] = [];
  try {
    const cookieHeader = cookieStore.toString();
    const result = await getOrderPageData(orderId, cookieHeader);
    if (result.order === null) {
      notFound();
    }
    order = result.order;
    savedPaymentMethods = result.savedPaymentMethods;
  } catch {
    notFound();
  }

  const currentStep = STEP_ORDER[order.status];
  const isCancelled = order.status === "cancelled";
  const amount = calculateOrderTotal(order);
  const isExpiredCreatedOrder =
    order.status === "created" && Boolean(order.expiresAt) && new Date(order.expiresAt) < new Date();
  const showHoldTimer = (order.status === "created" || order.status === "awaiting_payment") && order.expiresAt && new Date(order.expiresAt) > new Date();

  if (isExpiredCreatedOrder) {
    redirect(`/checkout/recover?orderId=${order.id}`);
  }

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      {showHoldTimer && (
        <div className="sticky top-14 z-30 md:hidden">
          <HoldTimerRibbon expiresAt={order.expiresAt} tone="accent" />
        </div>
      )}

      {/* Back */}
      <Link
        href="/orders"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-mute hover:text-ink self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        My Orders
      </Link>

      {/* Hold Timer Ribbon (top-mounted for created/awaiting_payment) */}
      {showHoldTimer && (
        <div className="hidden md:block">
          <HoldTimerRibbon expiresAt={order.expiresAt} tone="accent" />
        </div>
      )}

      {/* Stepper */}
      {!isCancelled ? (
        <div className="bg-card border border-line rounded px-8 py-5">
          <ol className="flex items-center gap-0">
            {STEPS.map((step, idx) => {
              const done = currentStep > idx;
              const active = currentStep === idx;
              return (
                <li key={step.key} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium transition-colors",
                        done
                          ? "bg-accent text-on-accent"
                          : active
                          ? "bg-accent text-on-accent"
                          : "bg-subtle text-mute"
                      )}
                    >
                      {done ? <CheckCircle2 className="w-4 h-4" /> : step.icon}
                    </div>
                    <span
                      className={cn(
                        "text-xs font-medium text-center whitespace-nowrap",
                        active || done ? "text-ink" : "text-mute"
                      )}
                    >
                      {step.label}
                    </span>
                  </div>
                  {idx < STEPS.length - 1 && (
                    <div
                      className={cn(
                        "h-px flex-1 mx-3 mb-5 transition-colors",
                        currentStep > idx ? "bg-accent" : "bg-line"
                      )}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <div className="bg-card border border-line rounded px-6 py-4 flex items-center gap-3 border-l-4 border-l-bad-soft">
          <XCircle className="w-5 h-5 text-bad shrink-0" />
          <div>
            <p className="font-semibold text-sm">Order Cancelled</p>
            <p className="text-xs text-mute">
              This order has been cancelled.{" "}
              <Link href="/" className="underline text-accent">
                Browse tickets
              </Link>
              .
            </p>
          </div>
        </div>
      )}

      {/* Main panels */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Left — order summary */}
        <Card>
          <CardContent className="flex flex-col gap-6 pt-4">
            <h2 className="font-semibold text-lg tracking-tight text-ink">Order Summary</h2>

            <div className="flex flex-col gap-4">
              {/* Ticket name */}
              <div className="flex items-start gap-3">
                <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-accent/10 shrink-0 mt-0.5">
                  <Ticket className="w-4 h-4 text-accent" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs text-mute uppercase tracking-wider">Ticket</p>
                  <p className="font-medium leading-snug text-ink">{order.ticket.title}</p>
                </div>
              </div>

              {/* Price */}
              <div className="flex items-start gap-3">
                <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-accent/10 shrink-0 mt-0.5">
                  <DollarSign className="w-4 h-4 text-accent" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs text-mute uppercase tracking-wider">Amount</p>
                  <p className="font-semibold text-2xl text-ink font-mono tabular-nums">
                    ${amount.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            {/* Seats (seated orders only) */}
            {order.seats && order.seats.length > 0 && (
              <>
                <Divider />
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">Tickets</h3>
                    <span className="text-xs text-mute">
                      {order.seats.length} {order.seats.length === 1 ? "seat" : "seats"}
                    </span>
                  </div>
                  <div className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {order.seats.map((s) => {
                      const { row, seat } = parseSeatLabel(s.seatLabel);
                      return (
                        <div key={s.seatId} className="flex items-center gap-3 px-4 py-3">
                          <span className="inline-flex h-8 min-w-10 items-center justify-center rounded-md bg-accent-soft px-2 font-mono text-xs font-semibold tabular-nums text-accent">
                            {s.seatLabel}
                          </span>
                          <span className="flex-1 text-sm font-medium text-ink">
                            {seat ? `Row ${row} · Seat ${seat}` : row}
                          </span>
                          <span className="font-mono text-sm tabular-nums text-ink">
                            ${parseFloat(s.price).toFixed(2)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            <Divider />

            {/* Status row */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-mute">Status</span>
              <Badge className={cn("inline-flex items-center gap-1.5 text-xs", STATUS_BADGE[order.status])}>
                {STATUS_LABEL[order.status]}
              </Badge>
            </div>

            {/* Order ID */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-mute">Order ID</span>
              <span className="text-xs font-mono tabular-nums text-mute">{orderId.slice(0, 8)}…</span>
            </div>

            {/* Success message */}
            {order.status === "complete" && (
              <div className="flex flex-col gap-3 bg-ok-soft rounded-xl px-4 py-3 text-sm text-ok">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  Payment received — enjoy the event!
                </div>
                <Link
                  href={`/tickets/${order.ticket.id}/admission?orderId=${order.id}`}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
                >
                  Open Admission Pass
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right — step-dependent content */}
        {(order.status === "created" || order.status === "awaiting_payment") && order.expiresAt && (
          <OrderPaymentForm
            orderId={order.id}
            amount={amount}
            expiresAt={order.expiresAt}
            savedPaymentMethods={savedPaymentMethods}
          />
        )}

        {order.status === "complete" && (
          <Card>
            <CardContent className="flex flex-col gap-4 pt-4">
              <div className="flex items-center gap-2 text-ok">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                <h3 className="font-semibold text-ok">Payment Complete</h3>
              </div>
              <p className="text-sm text-mute">Your order is confirmed. Access your admission pass below.</p>
              <div className="flex-1" />
              <Link
                href={`/tickets/${order.ticket.id}/admission?orderId=${order.id}`}
                className={cn(buttonVariants({ variant: "primary", size: "default" }), "w-full")}
              >
                View Admission Pass
              </Link>
              <Link
                href={`/orders/${order.id}/transfer`}
                className={cn(buttonVariants({ variant: "outline", size: "default" }), "w-full")}
              >
                Send to friend
              </Link>
              <Link
                href={`/orders/${order.id}/refund`}
                className={cn(buttonVariants({ variant: "ghost", size: "default" }), "w-full")}
              >
                Request refund
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
