"use client";
// components/attach-seating-plan-form.tsx — Organizer panel for attaching /
// detaching a seating plan to/from a ticket.
//
// The organizer enters the seating plan UUID (obtained from venue-service after
// creating a draft plan) and clicks "Attach".  If a plan is already attached,
// a "Detach" button lets them remove it.
//
// All mutations go through Server Actions in app/actions/tickets.ts, which call
// the ticket-service attach/detach endpoints via Kong.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MapPin, Unlink, Loader2, AlertCircle, CheckCircle } from "lucide-react";
import { attachSeatingPlan, detachSeatingPlan } from "@/app/actions/tickets";
import type { TicketState } from "@/app/actions/tickets";

interface AttachSeatingPlanFormProps {
  ticketId: string;
  currentPlanId: string | null;
}

const initialState: TicketState = {};

export function AttachSeatingPlanForm({ ticketId, currentPlanId }: AttachSeatingPlanFormProps) {
  const boundAttach = attachSeatingPlan.bind(null, ticketId);
  const boundDetach = detachSeatingPlan.bind(null, ticketId);

  const [attachState, attachAction, attachPending] = useActionState(boundAttach, initialState);
  const [detachState, detachAction, detachPending] = useActionState(boundDetach, initialState);

  return (
    <div className="glass rounded-2xl p-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-primary" />
        <p className="font-semibold text-sm">Seating Plan</p>
      </div>

      {currentPlanId ? (
        /* Plan is attached — show ID and detach option */
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Attached plan</p>
            <p className="text-sm font-mono break-all text-primary">{currentPlanId}</p>
          </div>

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
        </div>
      ) : (
        /* No plan attached — show attach form */
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Create a seating plan in the venue manager, then paste its ID here to attach it.
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
              <Label htmlFor="planId" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Seating Plan ID
              </Label>
              <Input
                id="planId"
                name="planId"
                type="text"
                required
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                pattern="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
                title="Must be a valid UUID"
              />
            </div>

            <Button
              type="submit"
              className="w-full gap-2"
              disabled={attachPending}
            >
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
