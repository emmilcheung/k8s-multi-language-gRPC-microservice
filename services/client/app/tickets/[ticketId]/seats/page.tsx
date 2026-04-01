// app/tickets/[ticketId]/seats/page.tsx — Seat map viewer and checkout page.
// Server Component: fetches ticket + seating plan metadata, then hands off to
// the SeatMapClient Client Component for interactive seat selection.

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import Link from "next/link";
import { serverApi } from "@/lib/api";
import type { Ticket, SeatingPlan, AvailabilitySnapshot } from "@/lib/types";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import { SeatMapClient } from "@/components/seat-map-client";

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
    return { title: `Seats — ${ticket.title} — Ticketing` };
  } catch {
    return { title: "Seat Map — Ticketing" };
  }
}

export default async function SeatsPage({ params }: Props) {
  const { ticketId } = await params;

  // Require authentication — seated purchase must be authenticated.
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    redirect("/auth/signin");
  }

  let ticket: Ticket;
  try {
    ticket = await getTicket(ticketId);
  } catch {
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
            "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
          )}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to ticket
        </Link>
        <div className="glass rounded-2xl p-8 text-center">
          <p className="text-destructive font-semibold">Seating plan unavailable</p>
          <p className="text-sm text-muted-foreground mt-1">
            The seating plan for this ticket could not be loaded. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  // Fetch initial availability snapshot (server-side for first paint).
  let initialAvailability: AvailabilitySnapshot | null = null;
  try {
    const apiBase = (process.env.INTERNAL_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
    const availRes = await fetch(`${apiBase}/api/seating-plans/${planId}/availability`, {
      cache: "no-store",
    });
    if (availRes.ok) {
      initialAvailability = await availRes.json() as AvailabilitySnapshot;
    }
  } catch {
    // Non-fatal — client will re-fetch.
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto">
      <Link
        href={`/tickets/${ticketId}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to ticket
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{ticket.title}</h1>
        <p className="text-sm text-muted-foreground">
          {plan.name} — select your seats below
        </p>
      </div>

      <SeatMapClient
        ticketId={ticketId}
        planId={planId}
        plan={plan}
        initialAvailability={initialAvailability}
        basePrice={ticket.price}
      />
    </div>
  );
}
