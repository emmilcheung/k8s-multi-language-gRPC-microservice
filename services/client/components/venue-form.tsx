"use client";
// components/venue-form.tsx — Client Component for creating/editing venues.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Building2, Users, Globe, AlertCircle, Loader2, CheckCircle } from "lucide-react";
import type { VenueState } from "@/app/actions/venues";

// Common timezones for the dropdown (typed as plain input for simplicity)
const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
];

interface VenueFormProps {
  action: (_prev: VenueState, formData: FormData) => Promise<VenueState>;
  defaultName?: string;
  defaultCapacity?: number;
  defaultTimezone?: string;
  submitLabel?: string;
}

const initialState: VenueState = {};

export function VenueForm({
  action,
  defaultName = "",
  defaultCapacity,
  defaultTimezone = "America/New_York",
  submitLabel = "Create Venue",
}: VenueFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <div className="glass rounded-2xl w-full max-w-md p-8 flex flex-col gap-6">
      {/* Heading */}
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">{submitLabel}</h2>
        <p className="text-sm text-muted-foreground">
          Enter the details for your venue.
        </p>
      </div>

      <div className="h-px bg-white/6" />

      <form action={formAction} className="flex flex-col gap-4">
        {/* Error alert */}
        {state?.error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{state.error}</span>
          </div>
        )}

        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Venue Name
          </Label>
          <div className="relative">
            <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="name"
              name="name"
              type="text"
              required
              placeholder="Madison Square Garden"
              defaultValue={defaultName}
              className="pl-9"
            />
          </div>
        </div>

        {/* Capacity */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="capacity" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Total Capacity
          </Label>
          <div className="relative">
            <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="capacity"
              name="capacity"
              type="number"
              min="1"
              step="1"
              required
              placeholder="20000"
              defaultValue={defaultCapacity}
              className="pl-9"
            />
          </div>
        </div>

        {/* Timezone */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="timezone" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Timezone
          </Label>
          <div className="relative">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="timezone"
              name="timezone"
              type="text"
              required
              placeholder="America/New_York"
              defaultValue={defaultTimezone}
              list="timezones"
              className="pl-9"
            />
            <datalist id="timezones">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>
          <p className="text-xs text-muted-foreground">
            IANA timezone name (e.g. America/New_York, Europe/London).
          </p>
        </div>

        {/* Submit */}
        <Button
          type="submit"
          className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground mt-1"
          disabled={pending}
        >
          {pending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <CheckCircle className="w-4 h-4" />
              {submitLabel}
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
