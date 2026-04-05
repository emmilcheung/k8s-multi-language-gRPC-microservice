"use client";
// components/ticket-form.tsx — 2-step wizard for creating tickets (WS3)
// Step 1: Select ticket type (GA, Manual Seated, Auto Seated)
// Step 2: Dynamic fields based on type

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FileText,
  DollarSign,
  AlertCircle,
  Loader2,
  CheckCircle,
  Hash,
  Users,
  Radio,
  MapPin,
  Calendar,
  Image,
  AlignLeft,
} from "lucide-react";
import type { TicketState } from "@/app/actions/tickets";
import type { SeatingPlan, Section } from "@/lib/types";
import { fetchPlanSections } from "@/app/actions/venues";

interface TicketFormProps {
  action: (_prev: TicketState, formData: FormData) => Promise<TicketState>;
  defaultTitle?: string;
  defaultPrice?: number | string;
  defaultQuota?: number;
  defaultMaxPerUser?: number;
  /** Pre-select ticket type and skip to step 2 (for edit/update flows). */
  defaultTicketType?: TicketType;
  /** Active seating plans to show in the plan picker (seated ticket creation only). */
  availablePlans?: SeatingPlan[];
  submitLabel?: string;
}

export type TicketType = "GA" | "SEATED_MANUAL" | "SEATED_AUTO";

interface FormState {
  ticketType?: TicketType;
  title: string;
  price: string;
  quota?: number;
  maxPerUser?: number;
  seatingPlanId?: string;
  pricingMode?: "single" | "section" | "seat";
  sectionPrices?: Record<string, string>;
  totalCapacity?: number;
  // Event metadata
  startsAt: string;
  endsAt: string;
  eventTitle: string;
  eventDescription: string;
  eventImageUrl: string;
  venueName: string;
  venueAddress: string;
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
};

export function TicketForm({
  action,
  defaultTitle = "",
  defaultPrice,
  defaultQuota,
  defaultMaxPerUser,
  defaultTicketType,
  availablePlans = [],
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
  });
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [planSections, setPlanSections] = useState<Section[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);

  // Fetch sections when section pricing mode + a plan is selected.
  const selectedPlanId = formData.seatingPlanId;
  const selectedPricingMode = formData.pricingMode;
  useEffect(() => {
    if (selectedPricingMode !== "section" || !selectedPlanId) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => { if (!cancelled) setSectionsLoading(true); })
      .then(() => fetchPlanSections(selectedPlanId))
      .then((sections) => { if (!cancelled) { setPlanSections(sections); setSectionsLoading(false); } })
      .catch(() => { if (!cancelled) { setPlanSections([]); setSectionsLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedPricingMode, selectedPlanId]);

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
      // Read from DOM as fallback for E2E tests where fill() doesn't update React state
      const getTitleValue = (): string => {
        const el = form.elements.namedItem("title") as HTMLInputElement | null;
        return el?.value || formData.title;
      };
      const getPriceValue = (): string => {
        const el = form.elements.namedItem("price") as HTMLInputElement | null;
        return el?.value || formData.price;
      };
      const getStartsAtValue = (): string => {
        const el = form.elements.namedItem("startsAt") as HTMLInputElement | null;
        return el?.value || formData.startsAt;
      };

      const title = getTitleValue();
      const price = getPriceValue();
      const startsAt = getStartsAtValue();

      const formDataObj = new FormData();
      formDataObj.append("title", title);
      formDataObj.append("price", price);
      formDataObj.append("ticketType", ticketType || "");

      if (ticketType === "GA") {
        if (formData.quota) formDataObj.append("quota", String(formData.quota));
        if (formData.maxPerUser) formDataObj.append("maxPerUser", String(formData.maxPerUser));
      } else if (ticketType?.startsWith("SEATED")) {
        if (formData.seatingPlanId) formDataObj.append("seatingPlanId", formData.seatingPlanId);
        if (formData.pricingMode) formDataObj.append("pricingMode", formData.pricingMode);
        if (formData.maxPerUser) formDataObj.append("maxSeatsPerOrder", String(formData.maxPerUser));
        if (formData.pricingMode === "section" && formData.sectionPrices) {
          formDataObj.append("sectionPrices", JSON.stringify(formData.sectionPrices));
        }
      }

      // Event metadata — required startsAt + optional fields
      // Only include event data if startsAt is provided (required for create, skip for update)
      if (startsAt) {
        formDataObj.append("startsAt", startsAt);
      }
      if (formData.eventTitle.trim()) formDataObj.append("eventTitle", formData.eventTitle.trim());
      if (formData.endsAt) formDataObj.append("endsAt", formData.endsAt);
      if (formData.eventDescription.trim()) formDataObj.append("eventDescription", formData.eventDescription.trim());
      if (formData.eventImageUrl.trim()) formDataObj.append("eventImageUrl", formData.eventImageUrl.trim());
      if (formData.venueName.trim()) formDataObj.append("venueName", formData.venueName.trim());
      if (formData.venueAddress.trim()) formDataObj.append("venueAddress", formData.venueAddress.trim());

      const result = await action({}, formDataObj);
      if (result.error) {
        setError(result.error);
        setPending(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setPending(false);
    }
  };

  // Step 1: Select ticket type
  if (step === "type") {
    return (
      <div className="glass rounded-2xl w-full max-w-md p-8 flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold tracking-tight">Select Ticket Type</h2>
          <p className="text-sm text-muted-foreground">
            Choose how you want to sell your tickets.
          </p>
        </div>

        <div className="h-px bg-white/6" />

        <div className="flex flex-col gap-3">
          {/* GA Option */}
          <button
            type="button"
            onClick={() => handleTypeSelect("GA")}
            className="flex items-start gap-3 p-4 rounded-lg border border-white/10 hover:border-white/20 hover:bg-white/5 transition-all cursor-pointer text-left"
          >
            <Radio className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">General Admission</p>
              <p className="text-xs text-muted-foreground">
                Sell tickets with quantity limits. Buyers select how many they want.
              </p>
            </div>
          </button>

          {/* Manual Seated Option */}
          <button
            type="button"
            onClick={() => handleTypeSelect("SEATED_MANUAL")}
            className="flex items-start gap-3 p-4 rounded-lg border border-white/10 hover:border-white/20 hover:bg-white/5 transition-all cursor-pointer text-left"
          >
            <Radio className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">Manual Assigned Seating</p>
              <p className="text-xs text-muted-foreground">
                Buyers pick their own seats from your venue layout.
              </p>
            </div>
          </button>

          {/* Auto Seated Option */}
          <button
            type="button"
            onClick={() => handleTypeSelect("SEATED_AUTO")}
            className="flex items-start gap-3 p-4 rounded-lg border border-white/10 hover:border-white/20 hover:bg-white/5 transition-all cursor-pointer text-left"
          >
            <Radio className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">Auto-assigned Seating</p>
              <p className="text-xs text-muted-foreground">
                System automatically assigns seats to buyers.
              </p>
            </div>
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Details based on ticket type
  return (
    <form onSubmit={handleSubmit} className="glass rounded-2xl w-full max-w-md p-8 flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">
          {ticketType === "GA" ? "General Admission Details" : "Seating Plan Details"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {ticketType === "GA"
            ? "Configure your general admission ticket."
            : "Link a seating plan and set pricing."}
        </p>
      </div>

      <div className="h-px bg-white/6" />

      {/* Error alert */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Title (common to all types) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="title" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Title
        </Label>
        <div className="relative">
          <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

      {/* GA Fields */}
      {ticketType === "GA" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="price" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Price (USD)
            </Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quota" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Total Capacity
            </Label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="quota"
                name="quota"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 200"
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
            <p className="text-xs text-muted-foreground">
              Total tickets available for purchase.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="maxPerUser" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Max Per Buyer
            </Label>
            <div className="relative">
              <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="maxPerUser"
                name="maxPerUser"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 4"
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
            <p className="text-xs text-muted-foreground">
              Maximum tickets a single buyer can purchase in one order.
            </p>
          </div>
        </>
      )}

      {/* Seated Fields (Manual + Auto) */}
      {ticketType?.startsWith("SEATED") && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="seatingPlanId" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Seating Plan
            </Label>
            {availablePlans.length > 0 ? (
              <select
                id="seatingPlanId"
                name="seatingPlanId"
                required
                value={formData.seatingPlanId ?? ""}
                onChange={(e) => setFormData((prev) => ({ ...prev, seatingPlanId: e.target.value }))}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="" disabled>Select an active plan…</option>
                {availablePlans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="seatingPlanId"
                    name="seatingPlanId"
                    type="text"
                    required
                    placeholder="Paste seating plan ID"
                    value={formData.seatingPlanId ?? ""}
                    onChange={(e) => setFormData((prev) => ({ ...prev, seatingPlanId: e.target.value }))}
                    className="pl-9"
                  />
                </div>
                <p className="text-xs text-amber-400/80">
                  No active plans found. Create and activate a plan in the{" "}
                  <Link href="/venues" className="underline">Venue Manager</Link> first.
                </p>
              </>
            )}
          </div>

          {/* Pricing Mode Selector */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pricing Mode</p>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="pricingMode"
                  value="single"
                  checked={formData.pricingMode === "single" || !formData.pricingMode}
                  onChange={() => setFormData((prev) => ({ ...prev, pricingMode: "single" as const }))}
                  className="w-4 h-4"
                />
                <span className="text-sm">Single Price (all seats cost the same)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="pricingMode"
                  value="section"
                  checked={formData.pricingMode === "section"}
                  onChange={() => setFormData((prev) => ({ ...prev, pricingMode: "section" as const }))}
                  className="w-4 h-4"
                />
                <span className="text-sm">Section Pricing (different prices per section)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="pricingMode"
                  value="seat"
                  checked={formData.pricingMode === "seat"}
                  onChange={() => setFormData((prev) => ({ ...prev, pricingMode: "seat" as const }))}
                  className="w-4 h-4"
                />
                <span className="text-sm">Seat Pricing (configured in plan editor)</span>
              </label>
            </div>
          </div>

          {/* Single price mode */}
          {(formData.pricingMode === "single" || !formData.pricingMode) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Price (USD)
              </Label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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
              <p className="text-xs text-muted-foreground">
                Price for all seats in this plan.
              </p>
            </div>
          )}

          {/* Section pricing mode */}
          {formData.pricingMode === "section" && (
            <div className="flex flex-col gap-3">
              {sectionsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading sections…
                </div>
              ) : planSections.length === 0 ? (
                <p className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5">
                  No sections found for this plan. Select a plan first, or switch to Single Price.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">Set a price for each section:</p>
                  {planSections.map((section) => (
                    <div key={section.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{section.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {section.rowCount} × {section.columnCount} = {section.rowCount * section.columnCount} seats
                        </p>
                      </div>
                      <div className="relative w-28 shrink-0">
                        <DollarSign className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          required
                          placeholder="0.00"
                          value={formData.sectionPrices?.[section.id] ?? ""}
                          onChange={(e) =>
                            setFormData((prev) => ({
                              ...prev,
                              sectionPrices: { ...prev.sectionPrices, [section.id]: e.target.value },
                            }))
                          }
                          className="pl-7 text-sm"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Seat pricing mode */}
          {formData.pricingMode === "seat" && (
            <div className="p-3 bg-white/5 rounded-lg border border-white/10">
              <p className="text-sm text-muted-foreground">
                Configure seat-level pricing in the Seating Plan editor.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="maxSeatsPerOrder" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Max Seats Per Buyer
            </Label>
            <div className="relative">
              <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="maxSeatsPerOrder"
                name="maxSeatsPerOrder"
                type="number"
                min="1"
                step="1"
                placeholder="e.g. 4"
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
            <p className="text-xs text-muted-foreground">
              Maximum seats a single buyer can purchase in one order.
            </p>
          </div>
        </>
      )}

      {/* Event Details — shared by GA and Seated */}
      <div className="border-t border-white/8 pt-4 flex flex-col gap-4">
        <p className="text-sm font-semibold">Event Details</p>

        {/* Event title */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eventTitle" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Event Name
          </Label>
          <div className="relative">
            <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

        {/* Starts at — required */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="startsAt" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Event Date &amp; Time <span className="text-destructive">*</span>
          </Label>
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

        {/* Ends at — optional */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="endsAt" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            End Time <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

        {/* Description — optional */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eventDescription" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Description <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <div className="relative">
            <AlignLeft className="absolute left-3 top-3 w-4 h-4 text-muted-foreground pointer-events-none" />
            <textarea
              id="eventDescription"
              name="eventDescription"
              rows={3}
              placeholder="What&apos;s this event about?"
              value={formData.eventDescription}
              onChange={(e) => setFormData((prev) => ({ ...prev, eventDescription: e.target.value }))}
              className="w-full rounded-xl border border-white/10 bg-white/5 pl-9 pr-3 py-2 text-sm text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Image URL — optional */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eventImageUrl" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Event Image URL <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <div className="relative">
            <Image className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

        {/* Venue name — optional (auto for seated) */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="venueName" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Venue Name <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
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

        {/* Venue address — optional */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="venueAddress" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Venue Address <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="venueAddress"
              name="venueAddress"
              type="text"
              placeholder="4 Pennsylvania Plaza, New York, NY 10001"
              value={formData.venueAddress}
              onChange={(e) => setFormData((prev) => ({ ...prev, venueAddress: e.target.value }))}
              className="pl-9"
            />
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={handleBackToType}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button
          type="submit"
          className="flex-1 gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
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
      </div>
    </form>
  );
}
