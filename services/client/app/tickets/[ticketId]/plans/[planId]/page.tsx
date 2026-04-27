// app/tickets/[ticketId]/plans/[planId]/page.tsx — Ticket-scoped plan detail page.
// Shows plan info, sections, and allows adding sections + activating.
// Draft plans get the full interactive SeatingPlanCanvas editor.

import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/api";
import { activatePlan, deactivatePlan, createPriceTier, fetchPriceTiers } from "@/app/actions/venues";
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
import type { PlanState } from "@/app/actions/venues";

interface Props {
  params: Promise<{ ticketId: string; planId: string }>;
}

const planStatusColor: Record<SeatingPlan["status"], string> = {
  draft: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  inactive: "bg-muted/40 text-muted-foreground border-muted/20",
};

export default async function TicketPlanDetailPage({ params }: Props) {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) redirect("/auth/signin");

  const { ticketId, planId } = await params;

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

  // Verify the plan belongs to this ticket
  if (plan.ticketId !== ticketId) {
    notFound();
  }

  const sections = sectionsData?.sections ?? [];

  // Wrapper actions that bind the ticket context
  const addTierAction = async (_prev: PlanState, formData: FormData) => {
    return createPriceTier(planId, "", ticketId, _prev, formData);
  };

  const activatePlanAction = async (_prev: PlanState, formData: FormData) => {
    return activatePlan(planId, "", ticketId, _prev, formData);
  };

  const deactivatePlanAction = async (_prev: PlanState, formData: FormData) => {
    return deactivatePlan(planId, "", ticketId, _prev, formData);
  };

  const isDraft = plan.status === "draft";
  const isActive = plan.status === "active";

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto">
      {/* Back */}
      <Link
        href={`/tickets/${ticketId}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Ticket
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
          {plan.venueId && (
            <span className="flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5" />
              Venue: {plan.venueId.slice(0, 8)}…
            </span>
          )}
        </div>

        {/* Activate / Deactivate buttons */}
        <div className="flex gap-3 pt-2">
          {isDraft && sections.length > 0 && (
            <ActivatePlanButton action={activatePlanAction} />
          )}
          {isActive && (
            <DeactivatePlanButton action={deactivatePlanAction} />
          )}
        </div>
      </div>

      {/* Canvas for draft plans */}
      {isDraft && (
        <SeatingPlanCanvas planId={planId} sections={sections} isDraft={isDraft} />
      )}

      {/* Sections */}
      {sections.length > 0 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-semibold">Sections</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Configured seat sections.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {sections.map((section) => {
              const tier = tiers.find((t) => t.id === section.priceTierId);
              const capacity = section.type === "ga" ? section.columnCount : section.rowCount * section.columnCount;

              return (
                <div
                  key={section.id}
                  className="glass rounded-2xl p-4 flex items-center gap-4"
                >
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 ring-1 ring-primary/20 shrink-0">
                    <Grid3X3 className="w-5 h-5 text-primary" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{section.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {section.type === "ga"
                        ? `GA · ${capacity} capacity`
                        : `${section.rowCount} rows × ${section.columnCount} columns`}
                      {tier && ` · $${parseFloat(tier.price).toFixed(2)}`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Price tiers */}
      {tiers.length > 0 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-semibold">Price Tiers</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Available pricing levels for sections.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {tiers.map((tier) => (
              <div
                key={tier.id}
                className="glass rounded-2xl p-4 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium">{tier.name}</p>
                </div>
                <p className="text-sm font-semibold">
                  ${parseFloat(tier.price).toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add price tier form */}
      {isDraft && (
        <PriceTierForm action={addTierAction} tiers={tiers} />
      )}
    </div>
  );
}
