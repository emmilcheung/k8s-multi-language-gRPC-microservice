"use client";
// components/ticket-form.tsx — 2-step wizard for creating tickets
// Step 1: Select ticket type (GA, Manual Seated, Auto Seated)
// Step 2: Dynamic fields based on type

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  FileText,
  DollarSign,
  AlertCircle,
  Loader2,
  CheckCircle,
  Hash,
  Users,
  MapPin,
  Calendar,
  Image as ImageIcon,
  Radio,
  Armchair,
  Zap,
  ArrowLeft,
} from "lucide-react";
import type { TicketState } from "@/app/actions/tickets";
import { fetchMyVenues } from "@/app/actions/venues";
import type { Venue } from "@/app/actions/venues";

interface TicketFormProps {
  action: (_prev: TicketState, formData: FormData) => Promise<TicketState>;
  defaultTitle?: string;
  defaultPrice?: number | string;
  defaultQuota?: number;
  defaultMaxPerUser?: number;
  defaultTicketType?: TicketType;
   defaultVenueId?: string;
   defaultPricingMode?: "single" | "section" | "seat";
   defaultStartsAt?: string;
   defaultEndsAt?: string;
   defaultEventTitle?: string;
   defaultEventDescription?: string;
   defaultEventImageUrl?: string;
   defaultVenueName?: string;
   defaultVenueAddress?: string;
   defaultRequireQrForEntry?: boolean;
   attendanceLocked?: boolean;
  submitLabel?: string;
}

export type TicketType = "GA" | "SEATED_MANUAL" | "SEATED_AUTO";

interface FormState {
  ticketType?: TicketType;
  title: string;
  price: string;
  quota?: number;
  maxPerUser?: number;
  venueId?: string; // Phase 3: use venueId instead of seatingPlanId
  pricingMode?: "single" | "section" | "seat";
  sectionPrices?: Record<string, string>;
  totalCapacity?: number;
  startsAt: string;
  endsAt: string;
  eventTitle: string;
  eventDescription: string;
  eventImageUrl: string;
  venueName: string;
  venueAddress: string;
  requireQrForEntry: boolean;
}

const initialFormState: FormState = {
  title: "",
  price: "",
  startsAt: "",
  endsAt: "",
  eventTitle: "",
  eventDescription: "",
  eventImageUrl: "",
  venueName: "",
  venueAddress: "",
  requireQrForEntry: true,
};

const TICKET_TYPES: { value: TicketType; label: string; description: string; icon: React.ReactNode }[] = [
  {
    value: "GA",
    label: "General Admission",
    description: "Sell tickets with quantity limits. Buyers select how many they want.",
    icon: <Radio className="size-5 shrink-0 text-primary" />,
  },
  {
    value: "SEATED_MANUAL",
    label: "Manual Assigned Seating",
    description: "Buyers pick their own seats from your venue layout.",
    icon: <Armchair className="size-5 shrink-0 text-primary" />,
  },
  {
    value: "SEATED_AUTO",
    label: "Auto-assigned Seating",
    description: "System automatically assigns the best available seats.",
    icon: <Zap className="size-5 shrink-0 text-primary" />,
  },
];

function isRedirectError(error: unknown): error is Error & { digest?: string } {
  if (!(error instanceof Error)) return false;
  if (error.message === "NEXT_REDIRECT") return true;
  const redirectError = error as Error & { digest?: string };
  return typeof redirectError.digest === "string" && redirectError.digest.startsWith("NEXT_REDIRECT");
}

export function TicketForm({
  action,
  defaultTitle = "",
  defaultPrice,
  defaultQuota,
  defaultMaxPerUser,
  defaultTicketType,
  defaultVenueId,
  defaultPricingMode,
  defaultStartsAt = "",
  defaultEndsAt = "",
  defaultEventTitle = "",
  defaultEventDescription = "",
  defaultEventImageUrl = "",
  defaultVenueName = "",
  defaultVenueAddress = "",
  defaultRequireQrForEntry = true,
  attendanceLocked = false,
  submitLabel = "Create Ticket",
}: TicketFormProps) {
  const [step, setStep] = useState<"type" | "details">(defaultTicketType ? "details" : "type");
  const [ticketType, setTicketType] = useState<TicketType | undefined>(defaultTicketType);
  const [formData, setFormData] = useState<FormState>({
    ...initialFormState,
    title: defaultTitle,
    price: String(defaultPrice ?? ""),
    quota: defaultQuota,
    maxPerUser: defaultMaxPerUser,
    venueId: defaultVenueId,
    pricingMode: defaultPricingMode,
    startsAt: defaultStartsAt,
    endsAt: defaultEndsAt,
    eventTitle: defaultEventTitle,
    eventDescription: defaultEventDescription,
    eventImageUrl: defaultEventImageUrl,
    venueName: defaultVenueName,
    venueAddress: defaultVenueAddress,
    requireQrForEntry: defaultRequireQrForEntry,
  });
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [venuesLoading, setVenuesLoading] = useState(false);

  // Phase 3: Load venues when component mounts (for seated ticket creation)
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => { if (!cancelled) setVenuesLoading(true); })
      .then(() => fetchMyVenues())
      .then((v) => { if (!cancelled) { setVenues(v); setVenuesLoading(false); } })
      .catch(() => { if (!cancelled) { setVenues([]); setVenuesLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const selectedVenueId = formData.venueId;
  // Phase 3: Load plan sections when venueId or pricing mode changes
  // (Currently not used for section pricing - simplified for Phase 3)
  useEffect(() => {
    // Cleanup code here if needed
  }, [selectedVenueId]);

  const handleTypeSelect = (type: TicketType) => {
    setTicketType(type);
    setFormData((prev) => ({ ...prev, ticketType: type }));
    setError("");
    setStep("details");
  };

  const handleBackToType = () => {
    setStep("type");
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPending(true);
    setError("");

    try {
      const form = e.currentTarget as HTMLFormElement;
      const getFieldValue = (name: string): string => {
        const el = form.elements.namedItem(name) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        return el?.value ?? "";
      };
      const getTitleValue = (): string => {
        return getFieldValue("title") || formData.title;
      };
      const getPriceValue = (): string => {
        return getFieldValue("price") || formData.price;
      };
      const getStartsAtValue = (): string => {
        return getFieldValue("startsAt") || formData.startsAt;
      };
      const getEndsAtValue = (): string => {
        return getFieldValue("endsAt") || formData.endsAt;
      };
      const getEventTitleValue = (): string => {
        return getFieldValue("eventTitle") || formData.eventTitle;
      };
      const getEventDescriptionValue = (): string => {
        return getFieldValue("eventDescription") || formData.eventDescription;
      };
      const getEventImageUrlValue = (): string => {
        return getFieldValue("eventImageUrl") || formData.eventImageUrl;
      };
      const getVenueNameValue = (): string => {
        return getFieldValue("venueName") || formData.venueName;
      };
      const getVenueAddressValue = (): string => {
        return getFieldValue("venueAddress") || formData.venueAddress;
      };

      const title = getTitleValue();
      const price = getPriceValue();
      const startsAt = getStartsAtValue();
      const endsAt = getEndsAtValue();
      const eventTitle = getEventTitleValue().trim();
      const eventDescription = getEventDescriptionValue().trim();
      const eventImageUrl = getEventImageUrlValue().trim();
      const venueName = getVenueNameValue().trim();
      const venueAddress = getVenueAddressValue().trim();

      const formDataObj = new FormData();
      formDataObj.append("title", title);
      formDataObj.append("price", price);
      formDataObj.append("ticketType", ticketType || "");
      formDataObj.append("requireQrForEntry", String(formData.requireQrForEntry));

      if (ticketType === "GA") {
        if (formData.quota) formDataObj.append("quota", String(formData.quota));
        if (formData.maxPerUser) formDataObj.append("maxPerUser", String(formData.maxPerUser));
      } else if (ticketType?.startsWith("SEATED")) {
        // Phase 3: use venueId instead of seatingPlanId
        if (formData.venueId) formDataObj.append("venueId", formData.venueId);
        if (formData.pricingMode) formDataObj.append("pricingMode", formData.pricingMode);
        if (formData.maxPerUser) formDataObj.append("maxSeatsPerOrder", String(formData.maxPerUser));
        if (formData.pricingMode === "section" && formData.sectionPrices) {
          formDataObj.append("sectionPrices", JSON.stringify(formData.sectionPrices));
        }
      }

      if (startsAt) {
        formDataObj.append("startsAt", startsAt);
      }
      if (eventTitle) formDataObj.append("eventTitle", eventTitle);
      if (endsAt) formDataObj.append("endsAt", endsAt);
      if (eventDescription) formDataObj.append("eventDescription", eventDescription);
      if (eventImageUrl) formDataObj.append("eventImageUrl", eventImageUrl);
      if (venueName) formDataObj.append("venueName", venueName);
      if (venueAddress) formDataObj.append("venueAddress", venueAddress);

      const result = await action({}, formDataObj);
      if (result.error) {
        setError(result.error);
        setPending(false);
        return;
      }
      if (result.refreshed) {
        location.reload();
        return;
      }
      setPending(false);
    } catch (err) {
      if (isRedirectError(err)) return;
      setError(err instanceof Error ? err.message : "An error occurred");
      setPending(false);
    }
  };

  // ── Step 1: Select ticket type ────────────────────────────────────────────
  if (step === "type") {
    return (
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-8 flex flex-col gap-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold tracking-tight">Select Ticket Type</h2>
          <p className="text-sm text-muted-foreground">
            Choose how you want to sell your tickets.
          </p>
        </div>

        <Separator />

        <div className="flex flex-col gap-3">
          {TICKET_TYPES.map(({ value, label, description, icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => handleTypeSelect(value)}
              className="flex items-start gap-4 p-4 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 transition-all cursor-pointer text-left group"
            >
              <div className="flex items-center justify-center size-10 rounded-lg bg-primary/10 ring-1 ring-primary/20 shrink-0 group-hover:bg-primary/15 transition-colors">
                {icon}
              </div>
              <div className="flex flex-col gap-0.5 min-w-0">
                <p className="font-medium text-sm">{label}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Step 2: Details ───────────────────────────────────────────────────────
  const typeLabel = TICKET_TYPES.find((t) => t.value === ticketType)?.label ?? "Ticket";

  return (
    <form onSubmit={handleSubmit} className="bg-card border border-border rounded-lg w-full max-w-md p-8 flex flex-col gap-6 shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">
          {ticketType === "GA" ? "General Admission Details" : "Seating Plan Details"}
        </h2>
        <p className="text-sm text-muted-foreground">
          Type: <span className="text-foreground font-medium">{typeLabel}</span>
        </p>
      </div>

      <Separator />

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="title" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Title
        </Label>
        <div className="relative">
          <FileText className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            id="title"
            name="title"
            type="text"
            required
            placeholder="Concert at Madison Square Garden"
            value={formData.title}
            onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
            className="pl-9"
          />
        </div>
      </div>

      {/* ── GA Fields ── */}
      {ticketType === "GA" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Price (USD)
            </Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="price"
                name="price"
                type="number"
                step="0.01"
                min="0.01"
                required
                placeholder="9.99"
                value={formData.price}
                onChange={(e) => setFormData((prev) => ({ ...prev, price: e.target.value }))}
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="quota" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Capacity
              </Label>
              <div className="relative">
                <Hash className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="quota"
                  name="quota"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="200"
                  value={formData.quota ?? ""}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      quota: e.target.value ? parseInt(e.target.value) : undefined,
                    }))
                  }
                  className="pl-9"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="maxPerUser" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Max / Buyer
              </Label>
              <div className="relative">
                <Users className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="maxPerUser"
                  name="maxPerUser"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="4"
                  value={formData.maxPerUser ?? ""}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      maxPerUser: e.target.value ? parseInt(e.target.value) : undefined,
                    }))
                  }
                  className="pl-9"
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Seated Fields ── */}
      {ticketType?.startsWith("SEATED") && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Venue Template
            </Label>
            {venuesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading venues…
              </div>
            ) : venues.length > 0 ? (
              <Select
                value={formData.venueId ?? ""}
                onValueChange={(val) => setFormData((prev) => ({ ...prev, venueId: val !== null ? val : undefined }))}
              >
                <SelectTrigger className="w-full h-10">
                  <SelectValue placeholder="Select a venue…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {venues.map((venue) => (
                      <SelectItem key={venue.id} value={venue.id}>
                        {venue.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="venueId"
                    name="venueId"
                    type="text"
                    required
                    placeholder="Paste venue ID"
                    value={formData.venueId ?? ""}
                    onChange={(e) => setFormData((prev) => ({ ...prev, venueId: e.target.value }))}
                    className="pl-9"
                  />
                </div>
                <Alert>
                  <AlertCircle />
                  <AlertDescription>
                    No venues found. Create one in the{" "}
                    <Link href="/venues/new" className="underline">Venue Manager</Link> first.
                  </AlertDescription>
                </Alert>
              </>
            )}
          </div>

          {/* Pricing Mode */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pricing Mode</p>
            <ToggleGroup
              orientation="vertical"
              spacing={2}
              value={[formData.pricingMode ?? "single"]}
              onValueChange={(vals: string[]) => {
                const current = formData.pricingMode ?? "single";
                const next = vals.find((v) => v !== current) ?? current;
                setFormData((prev) => ({ ...prev, pricingMode: next as "single" | "section" | "seat" }));
              }}
              className="w-full"
            >
              <ToggleGroupItem value="single" variant="outline" className="w-full justify-start gap-2 text-sm font-normal">
                Single Price
                <span className="text-xs text-muted-foreground ml-1">all seats cost the same</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="section" variant="outline" className="w-full justify-start gap-2 text-sm font-normal">
                Section Pricing
                <span className="text-xs text-muted-foreground ml-1">different prices per section</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="seat" variant="outline" className="w-full justify-start gap-2 text-sm font-normal">
                Seat Pricing
                <span className="text-xs text-muted-foreground ml-1">configured in plan editor</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Single price */}
          {(formData.pricingMode === "single" || !formData.pricingMode) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Price (USD)
              </Label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="price"
                  name="price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="9.99"
                  value={formData.price}
                  onChange={(e) => setFormData((prev) => ({ ...prev, price: e.target.value }))}
                  className="pl-9"
                />
              </div>
              <p className="text-xs text-muted-foreground">Price for all seats in this event.</p>
            </div>
          )}

          {/* Section pricing */}
          {formData.pricingMode === "section" && (
            <Alert>
              <AlertCircle />
              <AlertDescription>
                Section pricing will be configured after the plan is created. For now, use Single Price.
              </AlertDescription>
            </Alert>
          )}

          {/* Seat pricing info */}
          {formData.pricingMode === "seat" && (
            <Alert>
              <AlertCircle />
              <AlertDescription>
                Configure seat-level pricing in the Seating Plan editor after creation.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="maxSeatsPerOrder" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Max Seats Per Buyer
            </Label>
            <div className="relative">
              <Users className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="maxSeatsPerOrder"
                name="maxSeatsPerOrder"
                type="number"
                min="1"
                step="1"
                placeholder="4"
                value={formData.maxPerUser ?? ""}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    maxPerUser: e.target.value ? parseInt(e.target.value) : undefined,
                  }))
                }
                className="pl-9"
              />
            </div>
          </div>
        </>
      )}

      {/* ── Event Details ── */}
      <Separator />

      <div className="flex flex-col gap-4">
        <p className="text-sm font-semibold">Event Details</p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eventTitle" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Event Name
          </Label>
          <div className="relative">
            <FileText className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              id="eventTitle"
              name="eventTitle"
              type="text"
              placeholder="e.g. Taylor Swift – Eras Tour"
              value={formData.eventTitle}
              onChange={(e) => setFormData((prev) => ({ ...prev, eventTitle: e.target.value }))}
              className="pl-9"
            />
          </div>
          <p className="text-xs text-muted-foreground">Defaults to ticket title if left blank.</p>
        </div>

        <div className="flex gap-4">
          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="startsAt" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Starts <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="startsAt"
                name="startsAt"
                type="datetime-local"
                value={formData.startsAt}
                onChange={(e) => setFormData((prev) => ({ ...prev, startsAt: e.target.value }))}
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="endsAt" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Ends <span className="text-muted-foreground font-normal">(opt.)</span>
            </Label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="endsAt"
                name="endsAt"
                type="datetime-local"
                value={formData.endsAt}
                onChange={(e) => setFormData((prev) => ({ ...prev, endsAt: e.target.value }))}
                className="pl-9"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eventDescription" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Description <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Textarea
            id="eventDescription"
            name="eventDescription"
            rows={3}
            placeholder="What's this event about?"
            value={formData.eventDescription}
            onChange={(e) => setFormData((prev) => ({ ...prev, eventDescription: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eventImageUrl" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Image URL <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <div className="relative">
            <ImageIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              id="eventImageUrl"
              name="eventImageUrl"
              type="url"
              placeholder="https://..."
              value={formData.eventImageUrl}
              onChange={(e) => setFormData((prev) => ({ ...prev, eventImageUrl: e.target.value }))}
              className="pl-9"
            />
          </div>
          <p className="text-xs text-muted-foreground">Shown as a banner on the ticket page.</p>
        </div>

        <div className="flex gap-4">
          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="venueName" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Venue <span className="text-muted-foreground font-normal">(opt.)</span>
            </Label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="venueName"
                name="venueName"
                type="text"
                placeholder="Madison Square Garden"
                value={formData.venueName}
                onChange={(e) => setFormData((prev) => ({ ...prev, venueName: e.target.value }))}
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="venueAddress" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Address <span className="text-muted-foreground font-normal">(opt.)</span>
            </Label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="venueAddress"
                name="venueAddress"
                type="text"
                placeholder="4 Pennsylvania Plaza, NY"
                value={formData.venueAddress}
                onChange={(e) => setFormData((prev) => ({ ...prev, venueAddress: e.target.value }))}
                className="pl-9"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/20 px-3 py-2">
          <Label htmlFor="requireQrForEntry" className="text-sm font-medium">
            Require QR admission
          </Label>
          <input
            id="requireQrForEntry"
            type="checkbox"
            checked={formData.requireQrForEntry}
            disabled={attendanceLocked}
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                requireQrForEntry: e.target.checked,
              }))
            }
          />
        </div>
        {attendanceLocked && (
          <p className="text-xs text-muted-foreground">
            Attendance requirement is locked because at least one ticket has already been sold.
          </p>
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-2 pt-2">
        {!defaultTicketType && (
          <Button
            type="button"
            onClick={handleBackToType}
            variant="outline"
            className="flex-1"
          >
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
        )}
        <Button
          type="submit"
          className={defaultTicketType ? "w-full" : "flex-1"}
          disabled={pending}
        >
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
      </div>
    </form>
  );
}
