// app/tickets/[ticketId]/page.tsx — Ticket detail page.
// Redesigned layout: hero band (left), quick facts, about section, purchase panel (sticky right).
// Owner edit form and seating preview in right column.

export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ApiError, serverApi } from "@/lib/api";
import { executeQuery } from "@/lib/graphql/execute";
import {
  TicketDetailDocument,
  AttendancePolicyDocument,
  TicketsBrowseDocument,
} from "@/lib/graphql/generated";
import type { Ticket, SeatingPlan, PriceTier, AvailabilitySnapshot } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EventPoster } from "@/components/system";
import { cn } from "@/lib/utils";
import { TicketForm } from "@/components/ticket-form";
import { SeatingPlanPreview } from "@/components/seating-plan-preview";
import { updateTicket } from "@/app/actions/tickets";
import { fetchPriceTiers } from "@/app/actions/venues";
import { PurchasePanel } from "./_components/purchase-panel";
import { QuickFacts } from "./_components/quick-facts";
import { SaveEventButton } from "./_components/save-event-button";
import { ArrowLeft } from "lucide-react";

interface Props {
  params: Promise<{ ticketId: string }>;
}

function toDateTimeLocalInput(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toTicketFormType(
  ticket: Ticket,
  attachedPlan: SeatingPlan | null
): "GA" | "SEATED_MANUAL" | "SEATED_AUTO" {
  if (ticket.ticketType === "SEATED_AUTO" || attachedPlan?.assignmentMode === "auto") {
    return "SEATED_AUTO";
  }
  if (ticket.ticketType === "SEATED_MANUAL" || attachedPlan?.assignmentMode === "manual" || ticket.seatingPlanId) {
    return "SEATED_MANUAL";
  }
  return "GA";
}

async function getTicket(ticketId: string): Promise<Ticket & { savedByMe: boolean }> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const data = await executeQuery(TicketDetailDocument, { id: ticketId }, { cookie: cookieHeader });

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
    quota: gql.quota,
    reserved: gql.reserved,
    sold: gql.sold,
    available: gql.available,
    maxPerUser: gql.maxPerUser ?? undefined,
    ticketType: gql.ticketType,
    seatingPlanId: gql.seatingPlan?.id ?? undefined,
    savedByMe: gql.savedByMe,
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
  } as Ticket & { savedByMe: boolean };
}

export async function generateMetadata() {
  return { title: "Ticket — Ticketing" };
}

export default async function TicketDetailPage({ params }: Props) {
  const { ticketId } = await params;

  let ticket: Ticket & { savedByMe: boolean };
  try {
    ticket = await getTicket(ticketId);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }
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
  let defaultRequireQrForEntry = true;
  const attendanceLocked = (ticket.sold ?? 0) > 0;

  // When a plan is already attached, fetch its full details (sections included)
  // so the organizer can see a read-only preview of what is attached.
  let attachedPlan: SeatingPlan | null = null;
  let attachedPlanTiers: PriceTier[] = [];
  let attachedPlanAvailability: AvailabilitySnapshot | null = null;
  if (ticket.seatingPlanId) {
    const results = await Promise.allSettled([
      serverApi<SeatingPlan>(`/api/seating-plans/${ticket.seatingPlanId}`),
      serverApi<AvailabilitySnapshot>(`/api/seating-plans/${ticket.seatingPlanId}/availability`),
      ...(isOwner ? [fetchPriceTiers(ticket.seatingPlanId)] : []),
    ]);

    if (results[0]?.status === "fulfilled") {
      attachedPlan = results[0].value;
    }
    if (results[1]?.status === "fulfilled") {
      attachedPlanAvailability = results[1].value;
    }
    if (isOwner && results[2]?.status === "fulfilled") {
      attachedPlanTiers = results[2].value as PriceTier[];
    }
  }

  if (isOwner) {
    const policyResult = await executeQuery(
      AttendancePolicyDocument,
      { eventId: ticketId },
      { cookie: `token=${token}` }
    ).catch(() => null);
    if (
      policyResult?.attendancePolicy?.requireQrForEntry === true ||
      policyResult?.attendancePolicy?.requireQrForEntry === false
    ) {
      defaultRequireQrForEntry = policyResult.attendancePolicy.requireQrForEntry;
    }
  }

  // GA max-per-order: use ticket.quota if available, capped at 10, default 1.
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
    const data = await executeQuery(
      TicketsBrowseDocument,
      { first: 4 },
      { cookie: cookieStore.toString() }
    );
    relatedEvents = (data?.ticketsConnection?.edges ?? [])
      .map((edge) => edge.node)
      .filter((node) => node.id !== ticket.id)
      .slice(0, 3);
  } catch {
    relatedEvents = [];
  }
  const gaRemaining =
    !isSeated && ticket.quota != null
      ? Math.max(0, ticket.quota - (ticket.reserved ?? 0) - (ticket.sold ?? 0))
      : null;
  const seatedPlanInactive = isSeated && attachedPlan != null && attachedPlan.status !== "active";
  const seatedSoldOut =
    isSeated &&
    attachedPlan?.status === "active" &&
    attachedPlanAvailability != null &&
    attachedPlanAvailability.counts.available === 0;
  const gaUnavailable = !isSeated && gaRemaining != null && gaRemaining <= 0;
  const purchaseGate = isSeated
    ? seatedPlanInactive
      ? {
          label: "Unavailable",
          badge: "Unavailable",
          badgeClass: "bg-subtle/40 text-mute border-line/20",
          message: "This seating plan is not active, so this ticket cannot be purchased right now.",
        }
      : seatedSoldOut
        ? {
            label: "Sold Out",
            badge: "Sold Out",
            badgeClass: "bg-destructive/15 text-destructive border-destructive/20",
            message: "No seats are currently available for this ticket.",
          }
        : null
    : gaUnavailable
      ? {
          label: ticket.sold != null && ticket.quota != null && ticket.sold >= ticket.quota ? "Sold Out" : "Unavailable",
          badge:
            ticket.sold != null && ticket.quota != null && ticket.sold >= ticket.quota
              ? "Sold Out"
              : "Unavailable",
          badgeClass:
            ticket.sold != null && ticket.quota != null && ticket.sold >= ticket.quota
              ? "bg-destructive/15 text-destructive border-destructive/20"
              : "bg-subtle/40 text-mute border-line/20",
          message:
            ticket.sold != null && ticket.quota != null && ticket.sold >= ticket.quota
              ? "This ticket is sold out."
              : "All remaining tickets are currently reserved or unavailable.",
        }
      : isReserved
      ? {
          label: "Already Reserved",
          badge: "Already Reserved",
          badgeClass: "bg-subtle/40 text-mute border-line/20",
          message: "You already have an active reservation for this ticket.",
        }
      : null;

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
          {/* Hero band */}
          <div className="h-28 rounded-t-md bg-gradient-to-br from-accent/80 to-accent" />

          {/* Title */}
          <h1 className="text-3xl font-semibold text-ink leading-tight -mt-4">
            {ticket.event?.title || ticket.title || "Event"}
          </h1>

          {/* Chips row */}
          <div className="flex flex-wrap gap-2">
            <Badge tone="accent">{ticket.ticketType ?? "General"}</Badge>
            <Badge tone="neutral" dot>
              {(ticket.available ?? 0) > 0 ? "On sale" : "Sold out"}
            </Badge>
            {isOwner && <Badge tone="ink">Your listing</Badge>}
          </div>

          {/* Quick facts strip */}
          <QuickFacts ticket={ticket} gaRemaining={gaRemaining} />

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

          {/* Owner edit form */}
          {isOwner ? (
            <div className="flex flex-col gap-4">
              <div className="bg-card border border-line rounded p-4 flex flex-col gap-3">
                <p className="text-sm font-semibold">Attendance tools</p>
                <p className="text-xs text-mute">
                  Open attendance settings to view checked-in attendees and manage QR policy for this ticket.
                </p>
                <Link
                  href={`/organizer/events/${ticketId}/attendance`}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
                >
                  Attendance settings
                </Link>
                {defaultRequireQrForEntry && (
                  <Link
                    href={`/scan?eventId=${ticketId}`}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
                  >
                    Open Scanner Console
                  </Link>
                )}
              </div>

              {!isReserved ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Manage event</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <TicketForm
                      action={updateAction}
                      defaultTitle={ticket.title}
                      defaultPrice={ticket.price}
                      defaultQuota={ticket.quota}
                      defaultMaxPerUser={attachedPlan?.maxSeatsPerOrder ?? ticket.maxPerUser}
                      defaultTicketType={toTicketFormType(ticket, attachedPlan)}
                      defaultVenueId={attachedPlan?.venueId ?? undefined}
                      defaultSeatingPlanId={attachedPlan?.id ?? ticket.seatingPlanId ?? undefined}
                      defaultPricingMode={attachedPlan?.pricingMode}
                      defaultStartsAt={toDateTimeLocalInput(ticket.event?.startsAt)}
                      defaultEndsAt={toDateTimeLocalInput(ticket.event?.endsAt)}
                      defaultEventTitle={ticket.event?.title ?? ""}
                      defaultEventDescription={ticket.event?.description ?? ""}
                      defaultEventImageUrl={ticket.event?.imageUrl ?? ""}
                      defaultVenueName={ticket.event?.venueName ?? ""}
                      defaultVenueAddress={ticket.event?.venueAddress ?? ""}
                      defaultRequireQrForEntry={defaultRequireQrForEntry}
                      attendanceLocked={attendanceLocked}
                      submitLabel="Update Ticket"
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Your listing</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-mute">
                      This ticket is currently reserved and cannot be edited.
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* Read-only preview of the attached seating plan */}
              {attachedPlan && (
                <SeatingPlanPreview plan={attachedPlan} priceTiers={attachedPlanTiers} />
              )}
            </div>
          ) : null}

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
        {!isOwner && (
          <div className="flex flex-col gap-3">
            {currentUserId && (
              <SaveEventButton
                eventId={ticketId}
                initialSaved={ticket.savedByMe}
              />
            )}
            <PurchasePanel
              ticket={ticket}
              isOwner={isOwner}
              isSeated={isSeated}
              gaMaxQuantity={gaMaxQuantity}
              purchaseGate={purchaseGate}
              token={token}
            />
          </div>
        )}
      </div>
    </div>
  );
}
