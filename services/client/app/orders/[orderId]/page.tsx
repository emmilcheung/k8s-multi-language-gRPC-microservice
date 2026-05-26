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

  const canPay = order.status === "awaiting_payment" || order.status === "created";
  const currentStep = STEP_ORDER[order.status];
  const isCancelled = order.status === "cancelled";
  const amount = calculateOrderTotal(order);

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      {/* Back */}
      <Link
        href="/orders"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        My Orders
      </Link>

      {/* Stepper */}
      {!isCancelled ? (
        <div className="bg-card border border-border rounded px-8 py-5">
          <ol className="flex items-center gap-0">
            {STEPS.map((step, idx) => {
              const done = currentStep > idx;
              const active = currentStep === idx;
              return (
                <li key={step.key} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-full ring-1 transition-colors",
                        done
                          ? "bg-primary/20 ring-primary/40 text-primary"
                          : active
                          ? "bg-primary/15 ring-primary/60 text-primary"
                          : "bg-white/5 ring-white/10 text-muted-foreground"
                      )}
                    >
                      {done ? <CheckCircle2 className="w-4 h-4" /> : step.icon}
                    </div>
                    <span
                      className={cn(
                        "text-xs font-medium text-center whitespace-nowrap",
                        active ? "text-foreground" : done ? "text-primary/70" : "text-muted-foreground"
                      )}
                    >
                      {step.label}
                    </span>
                  </div>
                  {idx < STEPS.length - 1 && (
                    <div
                      className={cn(
                        "h-px flex-1 mx-3 mb-5 transition-colors",
                        currentStep > idx ? "bg-primary/40" : "bg-white/8"
                      )}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <div className="bg-card border border-border rounded px-6 py-4 flex items-center gap-3 border-l-4 border-l-destructive/60">
          <XCircle className="w-5 h-5 text-destructive shrink-0" />
          <div>
            <p className="font-semibold text-sm">Order Cancelled</p>
            <p className="text-xs text-muted-foreground">
              This order has been cancelled.{" "}
              <Link href="/" className="underline text-primary/80">
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
        <div className="bg-card border border-border rounded p-8 flex flex-col gap-6">
          <h2 className="font-bold text-lg tracking-tight">Order Summary</h2>

          <div className="flex flex-col gap-4">
            {/* Ticket name */}
            <div className="flex items-start gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/10 ring-1 ring-primary/20 shrink-0 mt-0.5">
                <Ticket className="w-4 h-4 text-primary" />
              </div>
              <div className="flex flex-col gap-0.5">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Ticket</p>
                <p className="font-semibold leading-snug">{order.ticket.title}</p>
              </div>
            </div>

            {/* Price */}
            <div className="flex items-start gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/10 ring-1 ring-primary/20 shrink-0 mt-0.5">
                <DollarSign className="w-4 h-4 text-primary" />
              </div>
              <div className="flex flex-col gap-0.5">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Amount</p>
                <p className="font-display font-extrabold text-2xl text-foreground">
                  ${amount.toFixed(2)}
                </p>
              </div>
            </div>
          </div>

          <div className="h-px bg-white/6" />

          {/* Status row */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Status</span>
            <Badge className={cn("inline-flex items-center gap-1.5 text-xs", STATUS_BADGE[order.status])}>
              {STATUS_LABEL[order.status]}
            </Badge>
          </div>

          {/* Order ID */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Order ID</span>
            <span className="text-xs font-mono text-muted-foreground">{orderId.slice(0, 8)}…</span>
          </div>

          {/* Success message */}
          {order.status === "complete" && (
            <div className="flex flex-col gap-3 bg-emerald-400/8 border border-emerald-400/20 rounded-xl px-4 py-3 text-sm text-emerald-400">
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
        </div>

        {/* Right — payment form (only shown for payable orders) */}
        {canPay && (
          <OrderPaymentForm
            orderId={order.id}
            amount={amount}
            expiresAt={order.expiresAt}
            savedPaymentMethods={savedPaymentMethods}
          />
        )}
      </div>
    </div>
  );
}
