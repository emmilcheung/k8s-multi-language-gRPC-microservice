// app/tickets/[ticketId]/page.tsx — Ticket detail page (public ISR shell).
// Buyer view only. Organizer editing lives at /organizer/events/[id]/edit.
// No server-side cookies() usage — this page renders as ISR (revalidate = 30s).

export const revalidate = 30;

// Opt this dynamic segment into static generation + ISR. Returning [] prerenders
// no specific ticket at build time; with dynamicParams (default true), each
// requested ticket is rendered on demand and then cached/revalidated — so the
// CDN/Kong can serve it with public, s-maxage headers instead of private.
export async function generateStaticParams(): Promise<{ ticketId: string }[]> {
  return [];
}

import { notFound } from "next/navigation";
import Link from "next/link";
import { ApiError } from "@/lib/api-error";
import { executePublicQuery } from "@/lib/graphql/execute-public";
import {
  TicketDetailPublicDocument,
  TicketsBrowseDocument,
} from "@/lib/graphql/generated";
import type { Ticket } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EventPoster } from "@/components/system";
import { cn } from "@/lib/utils";
import { PurchasePanel } from "./_components/purchase-panel";
import { QuickFacts } from "./_components/quick-facts";
import { SaveEventButton } from "./_components/save-event-button";
import { ArrowLeft, MapPin } from "lucide-react";

interface Props {
  params: Promise<{ ticketId: string }>;
}

// Coarse availability bucket — never expose the raw remaining count on the
// static shell (it is seconds-stale by design; the exact count is enforced
// server-side at reservation time).
type Availability = "on_sale" | "few_left" | "sold_out";
const FEW_LEFT_THRESHOLD = 20;

function coarseAvailability(remaining: number | null): Availability {
  if (remaining == null) return "on_sale";
  if (remaining <= 0) return "sold_out";
  if (remaining <= FEW_LEFT_THRESHOLD) return "few_left";
  return "on_sale";
}

async function getTicket(ticketId: string): Promise<Ticket> {
  const data = await executePublicQuery(TicketDetailPublicDocument, { id: ticketId });

  if (!data.ticket) {
    notFound();
  }

  const gql = data.ticket;

  return {
    id: gql.id,
    title: gql.title,
    price: gql.priceDecimal,
    userId: gql.userId,
    orderId: gql.orderId ?? undefined,
    version: 0,
    quota: gql.quota,
    reserved: gql.reserved,
    sold: gql.sold,
    available: gql.available,
    maxPerUser: gql.maxPerUser ?? undefined,
    ticketType: gql.ticketType,
    seatingPlanId: gql.seatingPlan?.id ?? undefined,
    event: gql.event
      ? {
          title: gql.event.title,
          description: gql.event.description ?? undefined,
          startsAt: gql.event.startsAt,
          endsAt: gql.event.endsAt ?? undefined,
          imageUrl: gql.event.imageUrl ?? undefined,
          venueName: gql.event.venueName ?? undefined,
          venueAddress: gql.event.venueAddress ?? undefined,
        }
      : undefined,
  };
}

export async function generateMetadata() {
  return { title: "Ticket — Ticketing" };
}

export default async function TicketDetailPage({ params }: Props) {
  const { ticketId } = await params;

  let ticket: Ticket;
  try {
    ticket = await getTicket(ticketId);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }
    notFound();
  }

  const isSeated = Boolean(ticket.seatingPlanId);

  // GA max-per-order: honour maxPerUser if set; fall back to quota cap at 10; default 1.
  const gaMaxQuantity = ticket.quota
    ? Math.min(ticket.maxPerUser ?? ticket.quota, Math.min(ticket.quota, 10))
    : 1;

  let relatedEvents: Array<{
    id: string;
    title: string;
    price: number;
    event?: {
      title?: string | null;
      startsAt?: string | null;
      venueName?: string | null;
    } | null;
  }> = [];
  try {
    const data = await executePublicQuery(TicketsBrowseDocument, { first: 4 });
    relatedEvents = (data?.ticketsConnection?.edges ?? [])
      .map((edge) => edge.node)
      .filter((node) => node.id !== ticket.id)
      .slice(0, 3);
  } catch {
    relatedEvents = [];
  }

  // GA availability: compute coarse bucket from quota counters.
  // For seated tickets the seats page handles per-section availability.
  const gaRemaining =
    !isSeated && ticket.quota != null
      ? Math.max(0, ticket.quota - (ticket.reserved ?? 0) - (ticket.sold ?? 0))
      : null;

  const availability = coarseAvailability(isSeated ? null : gaRemaining);

  // GA purchase gate: only block when sold out / unavailable at the coarse level.
  // "isReserved" is not derivable without a cookie, so we skip that gate on the
  // static shell — the PurchaseButton server action will catch double-reservations.
  const purchaseGate =
    !isSeated && availability === "sold_out"
      ? {
          label: "Sold Out",
          badge: "Sold Out",
          badgeClass: "bg-destructive/15 text-destructive border-destructive/20",
          message: "This ticket is sold out.",
        }
      : null;

  const availabilityLabel =
    availability === "sold_out"
      ? "Sold out"
      : availability === "few_left"
        ? "Few left"
        : "On sale";

  return (
    <div className="flex flex-col gap-8 max-w-6xl mx-auto">
      {/* Back button */}
      <Link
        href="/"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-mute self-start -ml-2 text-xs"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All tickets
      </Link>

      {/* Main grid: left column (content) + right column (purchase panel) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left — 2 columns of main content */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {/* Rich hero with background image or gradient */}
          <div className="relative overflow-hidden rounded-lg border border-line h-80">
            {/* Background — plain <img> (imageUrl is an arbitrary organizer URL;
                next/image would require every host in images.remotePatterns). */}
            {ticket.event?.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ticket.event.imageUrl}
                alt={ticket.event?.title || ticket.title || "Event"}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-accent/70 via-accent to-ink" />
            )}

            {/* Scrim overlay for legibility */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />

            {/* Top-left badges */}
            <div className="absolute top-4 left-4 flex gap-2 z-10">
              <Badge
                tone="neutral"
                dot
                className="bg-black/40 text-white border-white/25"
              >
                {availabilityLabel}
              </Badge>
              <Badge
                tone="neutral"
                className="bg-black/40 text-white border-white/25"
              >
                {ticket.ticketType ?? "General Admission"}
              </Badge>
            </div>

            {/* Bottom-left text overlay */}
            <div className="absolute bottom-0 left-0 right-0 p-6 text-white z-10">
              <div className="text-xs font-semibold uppercase tracking-widest opacity-85 mb-2">
                {ticket.event?.venueName ? "Live event" : "Event"}
              </div>
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight mb-2">
                {ticket.event?.title || ticket.title || "Event"}
              </h1>
              <div className="flex items-center gap-2 text-sm opacity-95">
                {ticket.event?.venueName && (
                  <>
                    <MapPin className="w-3.5 h-3.5" />
                    <span>{ticket.event.venueName}</span>
                  </>
                )}
                {ticket.event?.startsAt && (
                  <>
                    {ticket.event.venueName && <span>·</span>}
                    <span>
                      {new Date(ticket.event.startsAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Quick facts strip */}
          <QuickFacts ticket={ticket} gaRemaining={null} />

          {/* About section */}
          {ticket.event?.description ? (
            <div className="prose prose-sm max-w-none mt-2 text-text leading-relaxed">
              {ticket.event.description}
            </div>
          ) : (
            <p className="text-text leading-relaxed">
              More details coming soon.
            </p>
          )}

          {/* Ticket-content card (for all viewers) */}
          {isSeated ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pick your section</CardTitle>
                <p className="text-xs text-mute mt-1">Tap a section to view available seats and prices.</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {/* Placeholder seat map */}
                <div className="bg-subtle border border-line rounded-md h-40 flex items-center justify-center">
                  <span className="text-sm text-mute">Seat map</span>
                </div>
                <Link
                  href={`/tickets/${ticketId}/seats`}
                  className={cn(buttonVariants({ variant: "default", size: "sm" }), "w-full")}
                >
                  View seat map
                </Link>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ticket type</CardTitle>
              </CardHeader>
              <CardContent>
                {/* Single GA ticket type card */}
                <div
                  className={cn(
                    "p-4 rounded-md border border-l-2 bg-card",
                    "border-line border-l-accent flex flex-col gap-3"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">
                      {ticket.ticketType ?? "General Admission"}
                    </span>
                    <span className="text-sm font-semibold font-mono tabular-nums text-ink">
                      ${parseFloat(ticket.price).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "text-xs font-mono tabular-nums",
                        availability === "few_left" ? "text-bad" : "text-mute"
                      )}
                    >
                      {availabilityLabel}
                    </span>
                    <Badge tone="accent" className="text-xs">
                      Selected
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {relatedEvents.length > 0 && (
            <section className="mt-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">Related events</h2>
                <Link
                  href="/"
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "px-2")}
                >
                  Browse all
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {relatedEvents.map((item) => {
                  const startsAt = item.event?.startsAt;
                  const date = startsAt
                    ? new Date(startsAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })
                    : "TBA";
                  return (
                    <EventPoster
                      key={item.id}
                      title={item.event?.title || item.title}
                      venue={item.event?.venueName || "Venue TBA"}
                      date={date}
                      priceFromCents={Math.round(item.price * 100)}
                      href={`/tickets/${item.id}`}
                    />
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* Right column — sticky purchase panel */}
        <div className="flex flex-col gap-3">
          <SaveEventButton eventId={ticketId} />
          <PurchasePanel
            ticket={ticket}
            isSeated={isSeated}
            gaMaxQuantity={gaMaxQuantity}
            purchaseGate={purchaseGate}
          />
        </div>
      </div>
    </div>
  );
}
