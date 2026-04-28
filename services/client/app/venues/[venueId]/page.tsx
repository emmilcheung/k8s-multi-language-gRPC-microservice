// app/venues/[venueId]/page.tsx — Venue detail with seating plans (Server Component).

import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { fetchVenue, fetchPlansByVenue, fetchVenueSections, createVenueSection, deleteVenueSection } from "@/app/actions/venues";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { VenueSectionForm } from "@/components/venue-section-form";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Building2,
  Globe,
  MapPin,
  Pencil,
  Users,
  Layers,
} from "lucide-react";
import type { SeatingPlan } from "@/lib/types";

interface Props {
  params: Promise<{ venueId: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { venueId } = await params;
  return { title: `Venue ${venueId} — Ticketing` };
}

const planStatusColor: Record<SeatingPlan["status"], string> = {
  draft: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  inactive: "bg-muted/40 text-muted-foreground border-muted/20",
};

export default async function VenueDetailPage({ params }: Props) {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  const { venueId } = await params;

  const [venue, plans, venueSections] = await Promise.all([
    fetchVenue(venueId),
    fetchPlansByVenue(venueId),
    fetchVenueSections(venueId),
  ]);

  if (!venue) notFound();

  // Decode JWT to check ownership for the edit button.
  let currentUserId: string | null = null;
  try {
    const payloadB64 = token.split(".")[1];
    if (payloadB64) {
      const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
      const payload = JSON.parse(json) as { sub?: string };
      currentUserId = payload.sub ?? null;
    }
  } catch { /* non-fatal */ }

  const isOwner = currentUserId !== null && currentUserId === venue.organizerId;

  const addSectionAction = createVenueSection.bind(null, venueId);
  // Pre-bind a delete action for each section server-side so no factory function is
  // passed to the Client Component (plain functions cannot cross the server/client boundary).
  const sectionsWithActions = venueSections.map((s) => ({
    section: s,
    deleteAction: deleteVenueSection.bind(null, venueId, s.id),
  }));

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      {/* Back */}
      <Link
        href="/venues"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        My Venues
      </Link>

      {/* Venue info */}
      <div className="glass rounded-2xl p-8 flex flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
            <Building2 className="w-7 h-7 text-primary" />
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-primary/15 text-primary border-primary/20">Venue</Badge>
            {isOwner && (
              <Link
                href={`/venues/${venueId}/edit`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </Link>
            )}
          </div>
        </div>

        <div>
          <h1 className="text-3xl font-bold tracking-tight leading-tight">{venue.name}</h1>
        </div>

        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground pt-2 border-t border-white/6">
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            {venue.capacity.toLocaleString()} total capacity
          </span>
          <span className="flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" />
            {venue.address || venue.timezone}
          </span>
          {venue.address && (
            <span className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              {venue.timezone}
            </span>
          )}
        </div>
      </div>

      {/* Venue layout template */}
      <VenueSectionForm
        addAction={addSectionAction}
        sections={sectionsWithActions}
      />

      {/* Seating Plans — Read-only template preview */}
      {plans.length > 0 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-semibold">Seating Plans</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Plans created for tickets using this venue as a template. Plans are managed in ticket context.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="glass rounded-2xl p-5 flex items-center gap-4"
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
                  <Layers className="w-5 h-5 text-primary" />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">
                    {plan.name}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Max {plan.maxSeatsPerOrder} seats/order
                    {plan.ticketId && (
                      <> · Attached to ticket</>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Badge className={cn("text-xs", planStatusColor[plan.status])}>
                    {plan.status}
                  </Badge>
                  {plan.ticketId && (
                    <Link
                      href={`/tickets/${plan.ticketId}/plans/${plan.id}`}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "sm" }),
                        "gap-1 text-xs"
                      )}
                    >
                      Manage
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
