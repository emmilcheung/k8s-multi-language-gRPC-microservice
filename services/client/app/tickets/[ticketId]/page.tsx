// app/tickets/[ticketId]/page.tsx — Ticket detail page.
// Split layout: info panel (left) + action panel (right). Owner sees edit form.

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import Link from "next/link";
import { serverApi } from "@/lib/api";
import type { Ticket } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TicketForm } from "@/components/ticket-form";
import { PurchaseButton } from "@/components/purchase-button";
import { updateTicket } from "@/app/actions/tickets";
import {
  ArrowLeft,
  Ticket as TicketIcon,
  Tag,
  User,
  ShieldCheck,
} from "lucide-react";

interface Props {
  params: Promise<{ ticketId: string }>;
}

const getTicket = cache(async (ticketId: string): Promise<Ticket> => {
  return serverApi<Ticket>(`/api/tickets/${ticketId}`);
});

export async function generateMetadata({ params }: Props) {
  const { ticketId } = await params;
  try {
    const ticket = await getTicket(ticketId);
    return { title: `${ticket.title} — Ticketing` };
  } catch {
    return { title: "Ticket — Ticketing" };
  }
}

export default async function TicketDetailPage({ params }: Props) {
  const { ticketId } = await params;

  let ticket: Ticket;
  try {
    ticket = await getTicket(ticketId);
  } catch {
    notFound();
  }

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;

  // Extract user ID by decoding the JWT payload — no HTTP roundtrip needed (P-05).
  // Kong already verified the token's signature; we only need the `sub` claim here
  // for an owner check, so decoding without verification is safe in this context.
  let currentUserId: string | null = null;
  if (token) {
    try {
      const payloadB64 = token.split(".")[1];
      if (payloadB64) {
        const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
        const payload = JSON.parse(json) as { sub?: string };
        currentUserId = payload.sub ?? null;
      }
    } catch {
      // non-fatal — fall back to purchase-only view
    }
  }

  const isOwner = currentUserId !== null && currentUserId === ticket.userId;
  const isReserved = Boolean(ticket.orderId);
  const updateAction = updateTicket.bind(null, ticketId);

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      {/* Back */}
      <Link
        href="/"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All tickets
      </Link>

      {/* Main panel */}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Left — ticket info */}
        <div className="glass rounded-2xl p-8 flex flex-col gap-6">
          {/* Icon + reserved badge */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
              <TicketIcon className="w-7 h-7 text-primary" />
            </div>
            {isReserved && (
              <Badge className="bg-destructive/15 text-destructive border-destructive/20">
                Reserved
              </Badge>
            )}
          </div>

          {/* Title */}
          <h1 className="text-3xl font-bold tracking-tight leading-tight">
            {ticket.title}
          </h1>

          {/* Price pill */}
          <div className="flex items-center gap-3">
            <Tag className="w-4 h-4 text-muted-foreground" />
            <span className="text-2xl font-bold gradient-text">
              ${ticket.price.toFixed(2)}
            </span>
          </div>

          {/* Meta row */}
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground pt-2 border-t border-white/6">
            <span className="flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" />
              {isOwner ? "Your listing" : "Listed by seller"}
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-primary/60" />
              Secure purchase
            </span>
          </div>
        </div>

        {/* Right — action panel */}
        <div className="flex flex-col gap-4">
          {isOwner ? (
            /* Owner: edit form */
            !isReserved ? (
              <TicketForm
                action={updateAction}
                defaultTitle={ticket.title}
                defaultPrice={ticket.price}
                submitLabel="Update Ticket"
              />
            ) : (
              <div className="glass rounded-2xl p-6 flex flex-col gap-3">
                <p className="font-semibold">Your listing</p>
                <p className="text-sm text-muted-foreground">
                  This ticket is currently reserved and cannot be edited.
                </p>
              </div>
            )
          ) : (
            /* Buyer: purchase or sign-in */
            <div className="glass rounded-2xl p-6 flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">Total price</p>
                <p className="text-3xl font-bold gradient-text">
                  ${ticket.price.toFixed(2)}
                </p>
              </div>
              <div className="h-px bg-white/6" />
              {isReserved ? (
                <Button disabled className="w-full" variant="outline">
                  Already Reserved
                </Button>
              ) : token ? (
                <PurchaseButton ticketId={ticketId} />
              ) : (
                <Link
                  href="/auth/signin"
                  className={cn(
                    buttonVariants(),
                    "w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
                  )}
                >
                  Sign in to Purchase
                </Link>
              )}
              <p className="text-xs text-muted-foreground text-center">
                No hidden fees. Cancel before payment completes.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
