// app/venues/[venueId]/plans/new/page.tsx — Create a seating plan for a venue.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createSeatingPlan } from "@/app/actions/venues";
import { PlanForm } from "@/components/plan-form";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";

interface Props {
  params: Promise<{ venueId: string }>;
}

export const metadata = { title: "New Seating Plan — Ticketing" };

export default async function NewPlanPage({ params }: Props) {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  const { venueId } = await params;

  return (
    <div className="flex flex-col gap-8 max-w-2xl mx-auto">
      {/* Back */}
      <Link
        href={`/venues/${venueId}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Venue
      </Link>

      <div>
        <h1 className="text-3xl font-bold tracking-tight gradient-text">New Seating Plan</h1>
        <p className="text-muted-foreground mt-1">
          Create a seating plan, then add sections before activating and attaching it to a ticket.
        </p>
      </div>

      <PlanForm action={createSeatingPlan} venueId={venueId} />
    </div>
  );
}
