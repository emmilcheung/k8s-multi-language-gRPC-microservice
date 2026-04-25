// app/tickets/[ticketId]/page.tsx — Ticket detail page.
// Split layout: info panel (left) + action panel (right). Owner sees edit form.

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import Link from "next/link";
import { serverApi } from "@/lib/api";
import type { Ticket, SeatingPlan, PriceTier } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TicketForm } from "@/components/ticket-form";
import { PurchaseButton } from "@/components/purchase-button";
import { AttachSeatingPlanForm } from "@/components/attach-seating-plan-form";
import { SeatingPlanPreview } from "@/components/seating-plan-preview";
import { updateTicket } from "@/app/actions/tickets";
import { fetchAllMyPlans, fetchPriceTiers } from "@/app/actions/venues";
import { Separator } from "@/components/ui/separator";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import {
  ArrowLeft,
  Ticket as TicketIcon,
  Tag,
  User,
  ShieldCheck,
  MapPin,
  CalendarDays,
  AlignLeft,
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
  const isSeated = Boolean(ticket.seatingPlanId);
  // GA flow: reservation tracked in ticket.reserved counter (ticket.orderId is legacy).
  // A ticket is considered reserved when either the legacy orderId is set OR the
  // quota-based reserved counter is > 0 (meaning at least one active reservation exists).
  const isReserved = !isSeated && (Boolean(ticket.orderId) || (ticket.reserved != null && ticket.reserved > 0));
  const updateAction = updateTicket.bind(null, ticketId);

  // Fetch the organizer's plans server-side (only needed for the owner panel).
  // On failure (e.g. venue-service down) we degrade gracefully to an empty list.
  const availablePlans = isOwner ? await fetchAllMyPlans().catch(() => []) : [];

  // When a plan is already attached, fetch its full details (sections included)
  // so the organizer can see a read-only preview of what is attached.
  let attachedPlan: SeatingPlan | null = null;
  let attachedPlanTiers: PriceTier[] = [];
  if (isOwner && ticket.seatingPlanId) {
    try {
      [attachedPlan, attachedPlanTiers] = await Promise.all([
        serverApi<SeatingPlan>(`/api/seating-plans/${ticket.seatingPlanId}`),
        fetchPriceTiers(ticket.seatingPlanId),
      ]);
    } catch {
      // Non-fatal — preview is hidden, attach form still functional.
    }
  }

  // GA max-per-order: use ticket.quota if available, capped at 10, default 1.
  // GA max-per-order: honour maxPerUser if set; fall back to quota cap at 10; default 1.
  const gaMaxQuantity = ticket.quota
    ? Math.min(ticket.maxPerUser ?? ticket.quota, Math.min(ticket.quota, 10))
    : 1;

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      {/* Back */}
      <Link
        href="/"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2 text-xs"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All tickets
      </Link>

      {/* Main panel */}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Left — ticket info */}
        <div className="bg-card border border-border border-l-[3px] border-l-primary rounded overflow-hidden flex flex-col gap-6">
          {/* Event image banner */}
          {ticket.event?.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ticket.event.imageUrl}
              alt={ticket.event.title || ticket.title}
              className="w-full h-48 object-cover"
            />
          )}
          <div className="p-8 flex flex-col gap-6">
          {/* Icon + reserved badge */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
              <TicketIcon className="w-7 h-7 text-primary" />
            </div>
            <div className="flex items-center gap-2">
              {isSeated && (
                <Badge className="bg-primary/15 text-primary border-primary/20">
                  <MapPin className="w-3 h-3 mr-1" />
                  Seated
                </Badge>
              )}
              {isReserved && (
                <Badge className="bg-destructive/15 text-destructive border-destructive/20">
                  Reserved
                </Badge>
              )}
            </div>
          </div>

          {/* Title */}
          <h1 className="font-display font-extrabold text-2xl tracking-tight leading-tight">
            {ticket.event?.title || ticket.title}
          </h1>

          {/* Event date + venue */}
          {ticket.event?.startsAt && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm">
                <CalendarDays className="w-4 h-4 text-primary/70 shrink-0" />
                <span>
                  {new Date(ticket.event.startsAt).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}{" "}
                  ·{" "}
                  {new Date(ticket.event.startsAt).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              {ticket.event.venueName && (
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {ticket.event.venueName}
                    {ticket.event.venueAddress && (
                      <> · {ticket.event.venueAddress}</>
                    )}
                  </span>
                </div>
              )}
              {ticket.event.description && (
                <div className="flex items-start gap-2 text-sm text-muted-foreground mt-1">
                  <AlignLeft className="w-4 h-4 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">{ticket.event.description}</p>
                </div>
              )}
            </div>
          )}

          {/* Price */}
          <div className="flex items-center gap-3">
            <Tag className="w-4 h-4 text-muted-foreground" />
            <span className="font-display font-extrabold text-2xl text-foreground">
              ${parseFloat(ticket.price).toFixed(2)}
            </span>
          </div>

          <Separator />
          {/* Meta row */}
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" />
              {isOwner ? "Your listing" : "Listed by seller"}
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-primary/60" />
              Secure purchase
            </span>
          </div>

          {/* GA quota availability bar */}
          {ticket.quota != null && ticket.quota > 1 && (
            <div className="flex flex-col gap-2 pt-1">
              <Progress
                value={Math.min(100, (((ticket.reserved ?? 0) + (ticket.sold ?? 0)) / ticket.quota) * 100)}
              >
                <ProgressLabel>Availability</ProgressLabel>
                <span className="ml-auto text-sm text-muted-foreground tabular-nums">{Math.max(0, ticket.quota! - (ticket.reserved ?? 0) - (ticket.sold ?? 0))} / {ticket.quota} remaining</span>
              </Progress>
              {ticket.maxPerUser != null && ticket.maxPerUser > 1 && (
                <p className="text-xs text-muted-foreground">
                  Max {ticket.maxPerUser} per order
                </p>
              )}
            </div>
          )}
          </div>{/* end p-8 inner div */}
        </div>

        {/* Right — action panel */}
        <div className="flex flex-col gap-4">
          {isOwner ? (
            /* Owner: edit form + seating plan attachment */
            <div className="flex flex-col gap-4">
              {!isReserved ? (
                <TicketForm
                  action={updateAction}
                  defaultTitle={ticket.title}
                  defaultPrice={ticket.price}
                  defaultQuota={ticket.quota}
                  defaultMaxPerUser={ticket.maxPerUser}
                  defaultTicketType={(ticket.ticketType as "GA" | "SEATED_MANUAL" | "SEATED_AUTO") ?? "GA"}
                  submitLabel="Update Ticket"
                />
              ) : (
                <div className="bg-card border border-border rounded shadow-sm p-6 flex flex-col gap-3">
                  <p className="font-semibold">Your listing</p>
                  <p className="text-sm text-muted-foreground">
                    This ticket is currently reserved and cannot be edited.
                  </p>
                </div>
              )}
              {/* Seating plan management panel (CP-14) */}
              <AttachSeatingPlanForm
                ticketId={ticketId}
                currentPlanId={ticket.seatingPlanId ?? null}
                currentPlanName={attachedPlan?.name ?? null}
                hasActiveOrders={
                  (ticket.reserved != null && ticket.reserved > 0) ||
                  (ticket.sold != null && ticket.sold > 0)
                }
                availablePlans={availablePlans}
              />
              {/* Read-only preview of the attached seating plan */}
              {attachedPlan && (
                <SeatingPlanPreview plan={attachedPlan} priceTiers={attachedPlanTiers} />
              )}
            </div>
          ) : (
            /* Buyer: purchase or sign-in */
            <div className="bg-card border border-border rounded p-6 flex flex-col gap-4 shadow-sm">
              <div className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  {isSeated ? "Select your seats" : "Total price"}
                </p>
                <p className="font-display font-extrabold text-3xl text-foreground">
                  ${parseFloat(ticket.price).toFixed(2)}
                  {isSeated && (
                    <span className="text-sm font-normal text-muted-foreground ml-1">
                      /seat
                    </span>
                  )}
                </p>
              </div>
              <Separator />
              {isSeated ? (
                /* Seated ticket — CTA navigates to seat map */
                token ? (
                  <Link
                    href={`/tickets/${ticketId}/seats`}
                    className={cn(
                      buttonVariants(),
                      "w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
                    )}
                  >
                    <MapPin className="w-4 h-4" />
                    Choose Seats
                  </Link>
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
                )
              ) : isReserved ? (
                <Button disabled className="w-full" variant="outline">
                  Already Reserved
                </Button>
              ) : token ? (
                <PurchaseButton ticketId={ticketId} maxQuantity={gaMaxQuantity} />
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
