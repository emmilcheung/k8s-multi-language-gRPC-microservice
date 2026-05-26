// app/venues/[venueId]/plans/[planId]/page.tsx — Seating plan detail page.
// Shows plan info, sections, and allows adding sections + activating.
// Draft plans get the full interactive SeatingPlanCanvas editor.

export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/api";
import { createPriceTier, fetchPriceTiers } from "@/app/actions/venues";
import type { PlanState } from "@/app/actions/venues";
import { buttonVariants } from "@/components/ui/button-variants";
import { Badge } from "@/components/ui/badge";
import { SeatingPlanCanvas } from "@/components/seating-plan-canvas";
import { ActivatePlanButton } from "@/components/activate-plan-button";
import { DeactivatePlanButton } from "@/components/deactivate-plan-button";
import { PriceTierForm } from "@/components/price-tier-form";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Layers,
  MapPin,
  Users,
  Grid3X3,
} from "lucide-react";
import type { SeatingPlan, Section, PriceTier } from "@/lib/types";

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
  let tiers: PriceTier[] = [];
  try {
    [plan, sectionsData, tiers] = await Promise.all([
      serverApi<SeatingPlan>(`/api/seating-plans/${planId}`),
      serverApi<{ sections: Section[] }>(`/api/seating-plans/${planId}/sections`),
      fetchPriceTiers(planId),
    ]);
  } catch {
    notFound();
  }

  // If plan is attached to a ticket, redirect to ticket-scoped management
  if (plan.ticketId) {
    redirect(`/tickets/${plan.ticketId}/plans/${plan.id}`);
  }

  const sections = sectionsData?.sections ?? [];

  // Wrapper actions that bind the venue context (no ticketId for backward compat)
  const addTierAction = async (_prev: PlanState, formData: FormData) => {
    return createPriceTier(planId, venueId, "", _prev, formData);
  };

  const isDraft = plan.status === "draft";
  const isActive = plan.status === "active";

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

        {/* Plan ID — for reference / debugging */}
        <div className="bg-white/4 rounded-xl px-3 py-2 flex flex-col gap-0.5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Plan ID</p>
          <p className="font-mono text-sm text-foreground break-all">{plan.id}</p>
          <p className="text-xs text-muted-foreground">
            Activate this plan first, then attach it to a ticket from the ticket&apos;s detail page using the &ldquo;Seating Plan&rdquo; panel.
          </p>
        </div>
      </div>

      {/* Price tier management — draft plans only */}
      {isDraft && (
        <PriceTierForm action={addTierAction} tiers={tiers} />
      )}

      {/* Canvas — interactive for draft, read-only list for active/inactive */}
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold">Sections</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isDraft
              ? sections.length > 0
                ? "Sections are auto-provisioned from the venue template. Each event has its own independent seat inventory."
                : "Define the venue layout template first — sections are then auto-provisioned per event."
              : "The seating plan layout is locked once activated."}
          </p>
        </div>

        {isDraft && sections.length > 0 ? (
          /* ── Draft with sections: canvas for layout preview ── */
          <SeatingPlanCanvas
            planId={planId}
            sections={sections}
            initialLayout={plan.layoutJson}
            isDraft
          />
        ) : isDraft && sections.length === 0 ? (
          /* ── Draft but no sections yet: guide organiser to venue template ── */
          <div className="glass rounded-2xl p-8 flex flex-col items-center gap-4 text-center border border-yellow-500/20">
            <Grid3X3 className="w-10 h-10 text-muted-foreground" />
            <div>
              <p className="font-semibold text-sm text-yellow-400">No sections provisioned yet</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Define the seating layout on the venue page first. Sections are automatically cloned into this plan when the venue template is set up.
              </p>
            </div>
            <a
              href={`/venues/${venueId}`}
              className="text-sm text-primary underline underline-offset-2"
            >
              Set up venue layout →
            </a>
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
            {sections.map((s) => {
              const tier = tiers.find((t) => t.id === s.priceTierId);
              return (
                <div key={s.id} className="glass rounded-2xl p-4 flex items-center gap-4">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 ring-1 ring-primary/20 shrink-0">
                    <Grid3X3 className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{s.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {s.type.toUpperCase()} · {s.rowCount}R × {s.columnCount}C
                      {tier && ` · ${tier.name} $${parseFloat(tier.price).toFixed(2)}`}
                    </p>
                  </div>
                  <Badge className={s.type === "seated"
                    ? "bg-primary/15 text-primary border-primary/20 text-xs"
                    : "bg-muted/40 text-muted-foreground border-muted/20 text-xs"
                  }>
                    {s.type.toUpperCase()}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Activate section */}
      {isDraft && sections.length > 0 && (
        <div className="glass rounded-2xl p-5 flex flex-col gap-3 border border-emerald-500/20">
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-sm text-emerald-400">Activate this plan</p>
            <p className="text-xs text-muted-foreground">
              Once activated, the layout is locked and the plan can be attached to tickets for purchase.
            </p>
          </div>
          <ActivatePlanButton planId={planId} />
        </div>
      )}
      {isActive && (
        <div className="glass rounded-2xl p-5 flex flex-col gap-3 border border-destructive/20">
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-sm text-destructive">Deactivate this plan</p>
            <p className="text-xs text-muted-foreground">
              Stops new seat holds and purchases. Existing confirmed orders are unaffected.
            </p>
          </div>
          <DeactivatePlanButton planId={planId} />
        </div>
      )}
    </div>
  );
}
