"use client";
// Purchase panel component — sticky right-side panel with pricing, CTA, and trust strip

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PurchaseButton } from "@/components/purchase-button";
import { EventCountdown } from "./event-countdown";
import { Check, MapPin } from "lucide-react";
import type { Ticket } from "@/lib/types";

interface PurchasePanelProps {
  ticket: Ticket;
  isOwner: boolean;
  isSeated: boolean;
  gaMaxQuantity: number;
  purchaseGate: {
    label: string;
    badge: string;
    badgeClass: string;
    message: string;
  } | null;
  token: string | undefined;
}

export function PurchasePanel({
  ticket,
  isOwner,
  isSeated,
  gaMaxQuantity,
  purchaseGate,
  token,
}: PurchasePanelProps) {
  if (isOwner) {
    return null; // Owner sees the edit form instead, handled in main page
  }

  const priceCents = Math.round(parseFloat(ticket.price) * 100);
  const renderPrimaryAction = () => {
    if (purchaseGate) {
      if (purchaseGate.label === "Already Reserved" && token) {
        return (
          <Link href="/orders" className="w-full">
            <Button variant="outline" className="w-full">
              View your orders
            </Button>
          </Link>
        );
      }
      return (
        <Button disabled variant="outline" className="w-full">
          {purchaseGate.label}
        </Button>
      );
    }

    if (isSeated) {
      if (token) {
        return (
          <Link href={`/tickets/${ticket.id}/seats`} className="w-full">
            <Button variant="primary" className="w-full">
              Continue to seat map
            </Button>
          </Link>
        );
      }
      return (
        <Link href="/auth/signin" className="w-full">
          <Button variant="primary" className="w-full">
            Sign in to continue
          </Button>
        </Link>
      );
    }

    if (token) {
      return <PurchaseButton ticketId={ticket.id} maxQuantity={gaMaxQuantity} />;
    }
    return (
      <Link href="/auth/signin" className="w-full">
        <Button variant="primary" className="w-full">
          Sign in to Purchase
        </Button>
      </Link>
    );
  };

  return (
    <>
      <aside className="hidden self-start lg:sticky lg:top-20 lg:block">
      <Card elev className="gap-0 p-0">
        {/* From-price ribbon */}
        <div className="flex items-end justify-between gap-3 border-b border-line px-[18px] py-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mute">From</span>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[28px] font-semibold leading-none tracking-tight tabular-nums text-ink">
                ${(priceCents / 100).toFixed(2)}
              </span>
              <span className="text-xs text-mute">+ fees at checkout</span>
            </div>
          </div>
          {(ticket.available ?? 0) > 0 && (
            <Badge tone="warn" dot>{ticket.available} left</Badge>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3.5 px-[18px] py-[18px]">
          {/* Ticket type badges */}
          <div className="flex flex-wrap gap-2">
            <Badge tone="accent">{ticket.ticketType ?? "General"}</Badge>
            <Badge tone="neutral" dot>
              {(ticket.available ?? 0) > 0 ? "On sale" : "Sold out"}
            </Badge>
            {isSeated && (
              <Badge tone="accent">
                <MapPin className="mr-1 h-3 w-3" />
                Seated
              </Badge>
            )}
          </div>

          {/* Primary CTA */}
          <div className="flex flex-col gap-2">
            {renderPrimaryAction()}

            <p className="text-center text-xs text-mute">
              {purchaseGate
                ? purchaseGate.message
                : "No hidden fees. Cancel before payment completes."}
            </p>
          </div>

          {/* Event countdown */}
          {ticket.event?.startsAt && (
            <div className="border-t border-line pt-3.5">
              <EventCountdown startsAt={ticket.event.startsAt} />
            </div>
          )}

          {/* Trust strip */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3.5 text-xs text-mute">
            <span className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ok" />Mobile entry</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ok" />Refund-protected</span>
            <span className="inline-flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ok" />Transferable</span>
          </div>
        </div>
      </Card>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="shrink-0">
            <div className="text-[11px] uppercase tracking-wider text-mute">From</div>
            <div className="font-mono text-lg font-semibold text-ink tabular-nums">
              ${(priceCents / 100).toFixed(2)}
            </div>
          </div>
          <div className="min-w-0 flex-1">{renderPrimaryAction()}</div>
        </div>
      </div>
    </>
  );
}
