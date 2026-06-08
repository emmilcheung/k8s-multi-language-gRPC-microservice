// app/tickets/[ticketId]/seats/page.tsx — Seat map viewer and checkout page.
// Server Component: fetches ticket + seating plan metadata, then hands off to
// the SeatMapClient Client Component for interactive seat selection.

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ApiError, serverApi } from "@/lib/api";
import { executeQuery } from "@/lib/graphql/execute";
import { TicketDetailDocument } from "@/lib/graphql/generated";
import type { Ticket, SeatingPlan, PriceTier } from "@/lib/types";
import { fetchPriceTiers } from "@/app/actions/venues";
import { UrqlProvider } from "@/app/_lib/urql-client";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import { SeatMapClient } from "@/components/seat-map-client";

interface Props {
  params: Promise<{ ticketId: string }>;
}

const TICKET_LOAD_RETRY_DELAYS_MS = [250, 500, 750, 1000, 1250, 1500];

async function getTicket(ticketId: string, cookieHeader: string): Promise<Ticket> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= TICKET_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const data = await executeQuery(TicketDetailDocument, { id: ticketId }, { cookie: cookieHeader });
      if (!data.ticket) throw new ApiError(404, "Ticket not found");
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
      lastError = error;
      const status = error instanceof ApiError ? error.status : null;
      const shouldRetry =
        status === 404 ||
        (status !== null && status >= 500) ||
        !(error instanceof ApiError);
      if (!shouldRetry || attempt === TICKET_LOAD_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, TICKET_LOAD_RETRY_DELAYS_MS[attempt]));
    }
  }

  throw lastError ?? new Error("Failed to load ticket.");
}

export async function generateMetadata() {
  return { title: "Seat Map — Ticketing" };
}

export default async function SeatsPage({ params }: Props) {
  const { ticketId } = await params;

  // Require authentication — seated purchase must be authenticated.
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    redirect("/auth/signin");
  }
  const cookieHeader = `token=${token}`;

  let ticket: Ticket;
  try {
    ticket = await getTicket(ticketId, cookieHeader);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }
    notFound();
  }

  // Only seated tickets have a seat map.
  if (!ticket.seatingPlanId) {
    redirect(`/tickets/${ticketId}`);
  }

  const planId = ticket.seatingPlanId;

  // Fetch seating plan details (sections, status).
  let plan: SeatingPlan;
  try {
    plan = await serverApi<SeatingPlan>(`/api/seating-plans/${planId}`);
  } catch {
    // Plan not found or venue-service unavailable — surface a graceful error.
    return (
      <div className="flex flex-col gap-8 max-w-4xl mx-auto">
        <Link
          href={`/tickets/${ticketId}`}
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "gap-1.5 text-mute hover:text-ink self-start -ml-2"
          )}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to ticket
        </Link>
        <div className="glass rounded-2xl p-8 text-center">
          <p className="text-destructive font-semibold">Seating plan unavailable</p>
          <p className="text-sm text-mute mt-1">
            The seating plan for this ticket could not be loaded. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  if (plan.status !== "active") {
    return (
      <div className="flex flex-col gap-8 max-w-4xl mx-auto">
        <Link
          href={`/tickets/${ticketId}`}
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "gap-1.5 text-mute hover:text-ink self-start -ml-2"
          )}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to ticket
        </Link>
        <div className="glass rounded-2xl p-8 text-center">
          <p className="text-destructive font-semibold">Ticket unavailable</p>
          <p className="text-sm text-mute mt-1">
            This seating plan is not active, so seats cannot be selected right now.
          </p>
        </div>
      </div>
    );
  }

  let priceTiers: PriceTier[] = [];
  try {
    priceTiers = await fetchPriceTiers(planId);
  } catch {
    // Non-fatal — client will load price tiers separately.
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto">
      <Link
        href={`/tickets/${ticketId}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-mute hover:text-ink self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to ticket
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{ticket.title}</h1>
        <p className="text-sm text-mute">
          {plan.name} — select your seats below
        </p>
      </div>

      <UrqlProvider>
        <SeatMapClient
          ticketId={ticketId}
          planId={planId}
          plan={plan}
          basePrice={ticket.price}
          priceTiers={priceTiers}
          assignmentMode={plan.assignmentMode ?? "manual"}
        />
      </UrqlProvider>
    </div>
  );
}
