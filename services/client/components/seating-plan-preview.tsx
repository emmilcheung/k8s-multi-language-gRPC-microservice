// components/seating-plan-preview.tsx — Read-only seating plan summary shown on
// the ticket detail page after the organizer attaches a plan. Displays plan
// metadata, per-section breakdown, and a link to the full plan management page.

import Link from "next/link";
import { Layers, Grid3X3, ExternalLink, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SeatingPlan, Section, PriceTier } from "@/lib/types";

interface SeatingPlanPreviewProps {
  plan: SeatingPlan;
  priceTiers?: PriceTier[];
}

const STATUS_CLASS: Record<SeatingPlan["status"], string> = {
  draft: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  inactive: "bg-muted/40 text-muted-foreground border-muted/20",
};

function totalCapacity(sections: Section[]): number {
  return sections.reduce((sum, s) => {
    if (s.type === "ga") return sum + s.columnCount;
    return sum + s.rowCount * s.columnCount;
  }, 0);
}

export function SeatingPlanPreview({ plan, priceTiers = [] }: SeatingPlanPreviewProps) {
  const sections = plan.sections ?? [];
  const capacity = totalCapacity(sections);

  return (
    <div className="glass rounded-2xl p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 ring-1 ring-primary/20 shrink-0">
            <Layers className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">{plan.name}</p>
            <p className="text-xs text-muted-foreground font-mono">{plan.id.slice(0, 8)}…</p>
          </div>
        </div>
        <Badge className={cn("shrink-0 text-xs", STATUS_CLASS[plan.status])}>
          {plan.status}
        </Badge>
      </div>

      {/* Capacity summary */}
      {capacity > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="w-3.5 h-3.5" />
          <span>{capacity.toLocaleString()} total seats · {sections.length} section{sections.length !== 1 ? "s" : ""}</span>
        </div>
      )}

      {/* Sections */}
      {sections.length > 0 && (
        <div className="flex flex-col gap-2">
          {sections.map((s) => {
            const tier = priceTiers.find((t) => t.id === s.priceTierId);
            const cap = s.type === "ga" ? s.columnCount : s.rowCount * s.columnCount;
            return (
              <div
                key={s.id}
                className="flex items-center gap-2.5 bg-white/4 rounded-xl px-3 py-2"
              >
                <Grid3X3 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs font-medium flex-1 min-w-0 truncate">{s.name}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {s.type === "ga"
                    ? `GA · ${cap} cap.`
                    : `${s.rowCount}R × ${s.columnCount}C`}
                  {tier && ` · $${parseFloat(tier.price).toFixed(2)}`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Link to plan management page */}
      <Link
        href={`/venues/${plan.venueId}/plans/${plan.id}`}
        className="flex items-center gap-1.5 text-xs text-primary hover:underline self-start"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Manage plan
      </Link>
    </div>
  );
}
