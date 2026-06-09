// app/organizer/events/[id]/edit/page.tsx — Organizer event edit page.
// Auth-gated: only the ticket owner can access this route.
// Dynamic — reads cookies; organizer area is never cached.

import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ApiError, serverApi } from "@/lib/api";
import { executeQuery } from "@/lib/graphql/execute";
import { AttendancePolicyDocument, TicketDetailDocument } from "@/lib/graphql/generated";
import { readCurrentUserIdFromToken } from "@/lib/server-utils";
import type { AvailabilitySnapshot, PriceTier, SeatingPlan, Ticket } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { TicketForm } from "@/components/ticket-form";
import { SeatingPlanPreview } from "@/components/seating-plan-preview";
import { updateTicket } from "@/app/actions/tickets";
import { fetchPriceTiers } from "@/app/actions/venues";

interface Props {
  params: Promise<{ id: string }>;
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
  if (
    ticket.ticketType === "SEATED_MANUAL" ||
    attachedPlan?.assignmentMode === "manual" ||
    ticket.seatingPlanId
  ) {
    return "SEATED_MANUAL";
  }
  return "GA";
}

export default async function OrganizerEventEditPage({ params }: Props) {
  const { id } = await params;

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    redirect("/auth/signin");
  }
  const currentUserId = readCurrentUserIdFromToken(token);
  if (!currentUserId) {
    redirect("/auth/signin");
  }

  const cookie = cookieStore.toString();

  let ticketData: Ticket;
  try {
    const data = await executeQuery(TicketDetailDocument, { id }, { cookie });
    if (!data.ticket) {
      notFound();
    }
    const gql = data.ticket;
    ticketData = {
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
    } as Ticket;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }
    notFound();
  }

  if (ticketData.userId !== currentUserId) {
    notFound();
  }

  const isSeated = Boolean(ticketData.seatingPlanId);
  const isReserved =
    !isSeated &&
    (Boolean(ticketData.orderId) ||
      (ticketData.reserved != null && ticketData.reserved > 0));
  const attendanceLocked = (ticketData.sold ?? 0) > 0;

  let attachedPlan: SeatingPlan | null = null;
  let attachedPlanTiers: PriceTier[] = [];
  let attachedPlanAvailability: AvailabilitySnapshot | null = null;
  if (ticketData.seatingPlanId) {
    const results = await Promise.allSettled([
      serverApi<SeatingPlan>(`/api/seating-plans/${ticketData.seatingPlanId}`),
      serverApi<AvailabilitySnapshot>(
        `/api/seating-plans/${ticketData.seatingPlanId}/availability`
      ),
      fetchPriceTiers(ticketData.seatingPlanId),
    ]);

    if (results[0]?.status === "fulfilled") {
      attachedPlan = results[0].value;
    }
    if (results[1]?.status === "fulfilled") {
      attachedPlanAvailability = results[1].value;
    }
    if (results[2]?.status === "fulfilled") {
      attachedPlanTiers = results[2].value as PriceTier[];
    }
  }

  // Suppress unused-variable warning — fetched for future use (seated availability display).
  void attachedPlanAvailability;

  let defaultRequireQrForEntry = true;
  const policyResult = await executeQuery(
    AttendancePolicyDocument,
    { eventId: id },
    { cookie: `token=${token}` }
  ).catch(() => null);
  if (
    policyResult?.attendancePolicy?.requireQrForEntry === true ||
    policyResult?.attendancePolicy?.requireQrForEntry === false
  ) {
    defaultRequireQrForEntry = policyResult.attendancePolicy.requireQrForEntry;
  }

  const updateAction = updateTicket.bind(null, id);

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto">
      {/* Back link */}
      <Link
        href={`/tickets/${id}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-mute self-start -ml-2 text-xs"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to ticket
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {ticketData.event?.title || ticketData.title || "Manage event"}
        </h1>
        <p className="text-sm text-mute">
          Edit event details, manage attendance, and configure seating.
        </p>
      </div>

      {/* Attendance tools */}
      <div className="bg-card border border-line rounded p-4 flex flex-col gap-3">
        <p className="text-sm font-semibold">Attendance tools</p>
        <p className="text-xs text-mute">
          Open attendance settings to view checked-in attendees and manage QR policy for this
          ticket.
        </p>
        <Link
          href={`/organizer/events/${id}/attendance`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
        >
          Attendance settings
        </Link>
        {defaultRequireQrForEntry && (
          <Link
            href={`/scan?eventId=${id}`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
          >
            Open Scanner Console
          </Link>
        )}
      </div>

      {/* Edit form or reserved-state card */}
      {!isReserved ? (
        <Card>
          <CardHeader>
            <CardTitle>Manage event</CardTitle>
          </CardHeader>
          <CardContent>
            <TicketForm
              action={updateAction}
              defaultTitle={ticketData.title}
              defaultPrice={ticketData.price}
              defaultQuota={ticketData.quota}
              defaultMaxPerUser={attachedPlan?.maxSeatsPerOrder ?? ticketData.maxPerUser}
              defaultTicketType={toTicketFormType(ticketData, attachedPlan)}
              defaultVenueId={attachedPlan?.venueId ?? undefined}
              defaultSeatingPlanId={attachedPlan?.id ?? ticketData.seatingPlanId ?? undefined}
              defaultPricingMode={attachedPlan?.pricingMode}
              defaultStartsAt={toDateTimeLocalInput(ticketData.event?.startsAt)}
              defaultEndsAt={toDateTimeLocalInput(ticketData.event?.endsAt)}
              defaultEventTitle={ticketData.event?.title ?? ""}
              defaultEventDescription={ticketData.event?.description ?? ""}
              defaultEventImageUrl={ticketData.event?.imageUrl ?? ""}
              defaultVenueName={ticketData.event?.venueName ?? ""}
              defaultVenueAddress={ticketData.event?.venueAddress ?? ""}
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
  );
}
