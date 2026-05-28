"use client";
// Purchase panel component — sticky right-side panel with pricing, CTA, and trust strip

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PurchaseButton } from "@/components/purchase-button";
import { EventCountdown } from "./event-countdown";
import { MapPin } from "lucide-react";
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

  return (
    <aside className="lg:sticky lg:top-20 self-start">
      <Card elev className="flex flex-col gap-4">
        {/* From price */}
        <div className="flex flex-col gap-1">
          <div className="text-xs text-mute">from</div>
          <div className="text-2xl font-mono tabular-nums text-ink font-medium">
            ${(priceCents / 100).toFixed(2)}
          </div>
        </div>

        {/* Ticket type badges */}
        <div className="flex flex-wrap gap-2">
          <Badge tone="accent">{ticket.ticketType ?? "General"}</Badge>
          <Badge tone="neutral" dot>
            {(ticket.available ?? 0) > 0 ? "On sale" : "Sold out"}
          </Badge>
          {isSeated && (
            <Badge tone="accent">
              <MapPin className="w-3 h-3 mr-1" />
              Seated
            </Badge>
          )}
        </div>

        {/* Primary CTA */}
        <div className="flex flex-col gap-2">
          {purchaseGate ? (
            purchaseGate.label === "Already Reserved" && token ? (
              <Link href="/orders" className="w-full">
                <Button variant="outline" className="w-full">
                  View your orders
                </Button>
              </Link>
            ) : (
              <Button disabled variant="outline" className="w-full">
                {purchaseGate.label}
              </Button>
            )
          ) : isSeated ? (
            token ? (
              <Link href={`/tickets/${ticket.id}/seats`} className="w-full">
                <Button variant="primary" className="w-full">
                  Pick seats
                </Button>
              </Link>
            ) : (
              <Link href="/auth/signin" className="w-full">
                <Button variant="primary" className="w-full">
                  Sign in to Purchase
                </Button>
              </Link>
            )
          ) : token ? (
            <PurchaseButton ticketId={ticket.id} maxQuantity={gaMaxQuantity} />
          ) : (
            <Link href="/auth/signin" className="w-full">
              <Button variant="primary" className="w-full">
                Sign in to Purchase
              </Button>
            </Link>
          )}

          {purchaseGate && (
            <p className="text-xs text-mute text-center">
              {purchaseGate.message}
            </p>
          )}
          {!purchaseGate && (
            <p className="text-xs text-mute text-center">
              No hidden fees. Cancel before payment completes.
            </p>
          )}
        </div>

        {/* Event countdown */}
        {ticket.event?.startsAt && (
          <div className="pt-4 border-t border-line">
            <EventCountdown startsAt={ticket.event.startsAt} />
          </div>
        )}

        {/* Trust strip */}
        <div className="text-xs text-mute flex flex-col gap-1 pt-4 border-t border-line">
          <span>Secure checkout</span>
          <span>Verified seller</span>
          <span>Refund policy</span>
        </div>
      </Card>
    </aside>
  );
}
