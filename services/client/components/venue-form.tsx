"use client";
// components/venue-form.tsx — Client Component for creating/editing venues.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Building2, Users, Globe, MapPin, AlertCircle, Loader2, CheckCircle } from "lucide-react";
import type { VenueState } from "@/app/actions/venues";

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
  defaultAddress?: string;
  submitLabel?: string;
}

const initialState: VenueState = {};

export function VenueForm({
  action,
  defaultName = "",
  defaultCapacity,
  defaultTimezone = "America/New_York",
  defaultAddress = "",
  submitLabel = "Create Venue",
}: VenueFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <div className="w-full max-w-md rounded-xl border border-line bg-card p-8 flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight text-ink">{submitLabel}</h2>
        <p className="text-sm text-mute">Enter the details for your venue.</p>
      </div>

      <Separator />

      <form action={formAction} className="flex flex-col gap-4">
        {state?.error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name" className="text-xs font-medium text-mute uppercase tracking-wider">
            Venue Name
          </Label>
          <div className="relative">
            <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-mute pointer-events-none" />
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
          <Label htmlFor="capacity" className="text-xs font-medium text-mute uppercase tracking-wider">
            Total Capacity
          </Label>
          <div className="relative">
            <Users className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-mute pointer-events-none" />
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
          <Label htmlFor="timezone" className="text-xs font-medium text-mute uppercase tracking-wider">
            Timezone
          </Label>
          <div className="relative">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-mute pointer-events-none" />
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
          <p className="text-xs text-mute">
            IANA timezone name (e.g. America/New_York, Europe/London).
          </p>
        </div>

        {/* Address */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="address" className="text-xs font-medium text-mute uppercase tracking-wider">
            Address
          </Label>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-mute pointer-events-none" />
            <Input
              id="address"
              name="address"
              type="text"
              placeholder="123 Main St, New York, NY 10001"
              defaultValue={defaultAddress}
              className="pl-9"
            />
          </div>
          <p className="text-xs text-mute">
            Street address shown on ticket listings and event pages.
          </p>
        </div>

        <Button type="submit" className="w-full mt-1" disabled={pending}>
          {pending ? (
            <>
              <Loader2 data-icon="inline-start" className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <CheckCircle data-icon="inline-start" />
              {submitLabel}
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
