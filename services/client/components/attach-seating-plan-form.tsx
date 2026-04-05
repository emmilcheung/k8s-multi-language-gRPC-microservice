"use client";
// components/attach-seating-plan-form.tsx — Organizer panel for attaching /
// detaching a seating plan to/from a ticket.
//
// When no plan is attached the organizer selects from a dropdown of their draft
// plans (fetched server-side by the ticket detail page via fetchAllMyPlans()).
// If no plans exist they can navigate to the venue manager to create one.
//
// All mutations go through Server Actions in app/actions/tickets.ts.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MapPin, Unlink, Loader2, AlertCircle, CheckCircle, ExternalLink } from "lucide-react";
import { attachSeatingPlan, detachSeatingPlan } from "@/app/actions/tickets";
import type { TicketState } from "@/app/actions/tickets";
import type { SeatingPlan } from "@/lib/types";
import Link from "next/link";

interface AttachSeatingPlanFormProps {
  ticketId: string;
  currentPlanId: string | null;
  /** Name of the currently attached plan (if any) — shown instead of raw UUID. */
  currentPlanName?: string | null;
  /** Prevent detach when there are active reservations or sold tickets. */
  hasActiveOrders?: boolean;
  /** All plans for the organizer — active ones are shown in the dropdown */
  availablePlans?: SeatingPlan[];
}

const initialState: TicketState = {};

export function AttachSeatingPlanForm({
  ticketId,
  currentPlanId,
  currentPlanName,
  hasActiveOrders = false,
  availablePlans = [],
}: AttachSeatingPlanFormProps) {
  const boundAttach = attachSeatingPlan.bind(null, ticketId);
  const boundDetach = detachSeatingPlan.bind(null, ticketId);

  const [attachState, attachAction, attachPending] = useActionState(boundAttach, initialState);
  const [detachState, detachAction, detachPending] = useActionState(boundDetach, initialState);

  // Only show active plans — draft plans are not yet ready, inactive are closed
  const activePlans = availablePlans.filter((p) => p.status === "active");

  return (
    <div className="glass rounded-2xl p-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-primary" />
        <p className="font-semibold text-sm">Seating Plan</p>
      </div>

      {currentPlanId ? (
        /* Plan is attached — show name and detach option */
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Attached plan</p>
            {currentPlanName ? (
              <p className="text-sm font-medium text-primary">{currentPlanName}</p>
            ) : null}
            <p className="text-xs font-mono text-muted-foreground break-all">{currentPlanId}</p>
          </div>

          {hasActiveOrders ? (
            <p className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5">
              This plan cannot be changed while there are active reservations or sold tickets.
            </p>
          ) : (
            <>
              {detachState?.error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{detachState.error}</span>
                </div>
              )}

              <form action={detachAction}>
                <Button
                  type="submit"
                  variant="outline"
                  className="w-full gap-2 text-destructive border-destructive/30 hover:bg-destructive/10"
                  disabled={detachPending}
                >
                  {detachPending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Detaching…
                    </>
                  ) : (
                    <>
                      <Unlink className="w-4 h-4" />
                      Detach Seating Plan
                    </>
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      ) : activePlans.length === 0 ? (
        /* No active plans available — guide the organizer to activate one */
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            You have no active seating plans. Create and activate one in the venue manager first.
          </p>
          <Link
            href="/venues"
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Go to Venue Manager
          </Link>
        </div>
      ) : (
        /* Active plans available — show dropdown */
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Select an active seating plan to attach to this ticket.
          </p>

          {attachState?.error && (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{attachState.error}</span>
            </div>
          )}

          <form action={attachAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="planId"
                className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                Seating Plan
              </Label>
              <select
                id="planId"
                name="planId"
                required
                defaultValue=""
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="" disabled>
                  Select a plan…
                </option>
                {activePlans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} ({plan.id.slice(0, 8)}…)
                  </option>
                ))}
              </select>
            </div>

            <Button type="submit" className="w-full gap-2" disabled={attachPending}>
              {attachPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Attaching…
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4" />
                  Attach Seating Plan
                </>
              )}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
