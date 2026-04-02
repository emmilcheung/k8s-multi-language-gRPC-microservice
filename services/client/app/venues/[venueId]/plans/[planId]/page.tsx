// app/venues/[venueId]/plans/[planId]/page.tsx — Seating plan detail page.
// Shows plan info, sections, and allows adding sections + activating.
// Draft plans get the full interactive SeatingPlanCanvas editor.

import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/api";
import { createSection } from "@/app/actions/venues";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { SectionForm } from "@/components/section-form";
import { SeatingPlanCanvas } from "@/components/seating-plan-canvas";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Layers,
  MapPin,
  Users,
  ChevronRight,
  Grid3X3,
} from "lucide-react";
import type { SeatingPlan, Section } from "@/lib/types";

interface Props {
  params: Promise<{ venueId: string; planId: string }>;
}

const planStatusColor: Record<SeatingPlan["status"], string> = {
  draft: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  inactive: "bg-muted/40 text-muted-foreground border-muted/20",
};

export default async function PlanDetailPage({ params }: Props) {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  const { venueId, planId } = await params;

  let plan: SeatingPlan;
  let sectionsData: { sections: Section[] };
  try {
    [plan, sectionsData] = await Promise.all([
      serverApi<SeatingPlan>(`/api/seating-plans/${planId}`),
      serverApi<{ sections: Section[] }>(`/api/seating-plans/${planId}/sections`),
    ]);
  } catch {
    notFound();
  }

  const sections = sectionsData?.sections ?? [];

  // Bind planId + venueId into the createSection Server Action.
  const addSectionAction = createSection.bind(null, planId, venueId);

  const isDraft = plan.status === "draft";

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto">
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

      {/* Plan info */}
      <div className="glass rounded-2xl p-8 flex flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
            <Layers className="w-7 h-7 text-primary" />
          </div>
          <Badge className={cn("text-sm", planStatusColor[plan.status])}>
            {plan.status}
          </Badge>
        </div>

        <h1 className="text-3xl font-bold tracking-tight leading-tight">{plan.name}</h1>

        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground pt-2 border-t border-white/6">
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            Max {plan.maxSeatsPerOrder} seats per order
          </span>
          <span className="flex items-center gap-1.5">
            <ChevronRight className="w-3.5 h-3.5" />
            Hold TTL: {plan.holdTtlSec}s
          </span>
          {plan.ticketId && (
            <Link
              href={`/tickets/${plan.ticketId}`}
              className="flex items-center gap-1.5 text-primary hover:underline"
            >
              <MapPin className="w-3.5 h-3.5" />
              Attached to ticket
            </Link>
          )}
        </div>

        {/* Plan ID — for use in "Attach seating plan" form on ticket detail */}
        <div className="bg-white/4 rounded-xl px-3 py-2 flex flex-col gap-0.5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Plan ID</p>
          <p className="font-mono text-sm text-foreground break-all">{plan.id}</p>
          <p className="text-xs text-muted-foreground">
            Copy this ID to attach the plan to a ticket via the ticket&apos;s detail page.
          </p>
        </div>
      </div>

      {/* Canvas — interactive for draft, read-only list for active/inactive */}
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold">Sections</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isDraft
              ? "Drag sections to arrange the venue layout. Row strips inside seated sections can be dragged horizontally to stagger them."
              : "The seating plan layout is locked once activated."}
          </p>
        </div>

        {isDraft ? (
          /* ── Draft: full interactive canvas + add-section form ── */
          <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
            <SeatingPlanCanvas
              planId={planId}
              sections={sections}
              initialLayout={plan.layoutJson}
              isDraft
            />
            <SectionForm action={addSectionAction} />
          </div>
        ) : sections.length === 0 ? (
          /* ── No sections at all ── */
          <div className="glass rounded-2xl p-8 flex flex-col items-center gap-3 text-center">
            <Grid3X3 className="w-10 h-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No sections configured.</p>
          </div>
        ) : (
          /* ── Active/inactive: static read-only list ── */
          <div className="flex flex-col gap-3">
            {sections.map((s) => (
              <div key={s.id} className="glass rounded-2xl p-4 flex items-center gap-4">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 ring-1 ring-primary/20 shrink-0">
                  <Grid3X3 className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{s.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {s.sectionType} · {s.rowCount}R × {s.seatsPerRow}C · {s.capacity} seats
                  </p>
                </div>
                <Badge className={s.sectionType === "SEATED"
                  ? "bg-primary/15 text-primary border-primary/20 text-xs"
                  : "bg-muted/40 text-muted-foreground border-muted/20 text-xs"
                }>
                  {s.sectionType}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Activate hint */}
      {isDraft && sections.length > 0 && !plan.ticketId && (
        <div className="glass rounded-2xl p-5 flex flex-col gap-2 border border-yellow-500/20">
          <p className="font-semibold text-sm text-yellow-400">Ready to activate?</p>
          <p className="text-xs text-muted-foreground">
            First attach this plan to a ticket using the Plan ID above, then activate it via the ticket detail page.
          </p>
        </div>
      )}
    </div>
  );
}
