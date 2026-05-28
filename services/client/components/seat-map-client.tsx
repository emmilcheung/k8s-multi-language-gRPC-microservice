"use client";
// components/seat-map-client.tsx — Interactive seat map for seated ticket checkout.
//
// Layout:
//  - Section tabs (if plan has multiple sections)
//  - Seat grid: colour-coded by status (available / held / reserved / sold / blocked)
//  - Selection sidebar: selected seats, total price, confirm / auto-assign CTA
//  - Auto-assign panel: section + quantity selector for best-available flow
//
// Availability is polled every 5 s via urql useQuery (network-only).
// Hold/release mutations go through Kong's /graphql endpoint via useMutation.
//
// Security: userId is NEVER sent from this component — it is derived server-side
// from the Kong-injected X-User-Id header.

import { useState, useEffect, useTransition, useRef, useMemo } from "react";
import { useActionState } from "react";
import { useQuery, useMutation } from "urql";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  AlertCircle,
  CheckCircle,
  Shuffle,
  X,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SeatingPlan, SeatStatus, Section, PriceTier } from "@/lib/types";
import {
  SeatingPlanAvailabilityDocument,
  HoldSeatsDocument,
  ReleaseSeatsDocument,
} from "@/lib/graphql/generated";
import {
  createManualSeatedOrder,
  createAutoAssignSeatedOrder,
} from "@/app/actions/orders";
import type { SeatedOrderState } from "@/app/actions/orders";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { SeatGrid } from "@/components/system/seat-grid";
import { HoldTimerRibbon } from "@/components/system/hold-timer";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Parse seat label (e.g., "G12" or "G-12") into { row, number } for SeatGrid. */
function parseSeatLabel(label: string): { row: string; number: number } {
  // Remove hyphens and try to split row from number
  const normalized = label.replace(/-/g, "");
  const match = normalized.match(/^([A-Za-z]+)(\d+)$/);
  if (match) {
    const [, row, numberStr] = match;
    const number = parseInt(numberStr, 10);
    return { row, number: isNaN(number) ? 0 : number };
  }
  return { row: "", number: 0 };
}

// ─── types ────────────────────────────────────────────────────────────────────

interface SeatCell {
  id: string;
  label: string;
  status: SeatStatus;
}

interface Props {
  ticketId: string;
  planId: string;
  plan: SeatingPlan;
  basePrice: string;
  priceTiers?: PriceTier[];
  /** From the seating plan: "manual" or "auto" */
  assignmentMode?: "manual" | "auto";
}

// ─── component ────────────────────────────────────────────────────────────────

const INITIAL_ORDER_STATE: SeatedOrderState = {};

export function SeatMapClient({ ticketId, planId, plan, basePrice, priceTiers = [], assignmentMode = "manual" }: Props) {
  // Availability via urql — network-only so every fetch bypasses cache.
  const [{ data: availData, error: availError }, reexecute] = useQuery({
    query: SeatingPlanAvailabilityDocument,
    variables: { id: planId },
    requestPolicy: "network-only",
  });
  const loadError = availError ? "Could not load seat availability. Please refresh." : null;

  // Flat seatId → { status, sectionId } map built from the GraphQL response.
  const seatMap = useMemo<Record<string, { status: SeatStatus; sectionId: string }>>(() => {
    const map: Record<string, { status: SeatStatus; sectionId: string }> = {};
    for (const section of availData?.seatingPlan?.sections ?? []) {
      for (const seat of section.seats) {
        map[seat.id] = {
          status: seat.status.toLowerCase() as SeatStatus,
          sectionId: section.id,
        };
      }
    }
    return map;
  }, [availData]);

  // Hold/release mutations through Kong /graphql.
  const [, executeHoldSeats] = useMutation(HoldSeatsDocument);
  const [, executeReleaseSeats] = useMutation(ReleaseSeatsDocument);

  // Currently selected seat IDs (manual selection mode).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Seat IDs the current user has successfully held server-side.
  const [heldIds, setHeldIds] = useState<Set<string>>(new Set());
  // Hold expiry timestamp.
  const [holdExpiresAt, setHoldExpiresAt] = useState<string | null>(null);
  // Live countdown seconds remaining (null = no active hold).
  const [holdSecondsLeft, setHoldSecondsLeft] = useState<number | null>(null);
  const [holdJustExpired, setHoldJustExpired] = useState(false);

  // Section tab selection.
  const sections: Section[] = useMemo(() => plan.sections ?? [], [plan.sections]);
  const [activeSectionIdx, setActiveSectionIdx] = useState(0);
  const activeSection: Section | undefined = sections[activeSectionIdx];

  // Auto-assign mode is now determined by the plan, not buyer choice.
  const isAutoAssignMode = assignmentMode === "auto";
  const [autoQuantity, setAutoQuantity] = useState(1);

  // Hold action state.
  const [holdError, setHoldError] = useState<string | null>(null);
  const [, startHoldTransition] = useTransition();

  // Manual order action (bound below in JSX to avoid type issues with useActionState).
  const boundManual = createManualSeatedOrder.bind(null, ticketId, planId);
  const boundAutoAssign = createAutoAssignSeatedOrder.bind(null, ticketId, planId);
  const [manualState, manualFormAction, manualPending] = useActionState(boundManual, INITIAL_ORDER_STATE);
  const [autoState, autoFormAction, autoPending] = useActionState(boundAutoAssign, INITIAL_ORDER_STATE);

  // ── 5 s availability polling ──────────────────────────────────────────────

  useEffect(() => {
    const timer = setInterval(() => {
      reexecute({ requestPolicy: "network-only" });
    }, 5000);
    return () => clearInterval(timer);
  }, [reexecute]);

  // ── hold countdown timer ──────────────────────────────────────────────────

  useEffect(() => {
    if (!holdExpiresAt) {
      setHoldSecondsLeft(null);
      return;
    }

    const tick = () => {
      const secs = Math.max(0, Math.round((new Date(holdExpiresAt).getTime() - Date.now()) / 1000));
      setHoldSecondsLeft(secs);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [holdExpiresAt]);

  // ── seat selection helpers ────────────────────────────────────────────────

  const seatStatus = (seatId: string): SeatStatus => {
    if (heldIds.has(seatId)) return "held"; // held by the current user
    return seatMap[seatId]?.status ?? "available";
  };

  const isSeatSelectable = (seatId: string): boolean =>
    seatStatus(seatId) === "available" || selectedIds.has(seatId);

  const toggleSeat = (seatId: string) => {
    if (!isSeatSelectable(seatId)) return;
    if (!selectedIds.has(seatId) && selectedIds.size >= plan.maxSeatsPerOrder) {
      setHoldError(`You can select up to ${plan.maxSeatsPerOrder} seats per order.`);
      return;
    }

    if (holdJustExpired) setHoldJustExpired(false);

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(seatId)) {
        next.delete(seatId);
      } else {
        next.add(seatId);
      }
      return next;
    });
  };

  // ── hold on selection change ──────────────────────────────────────────────

  const prevSelectedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (holdExpiresAt && holdSecondsLeft === 0) {
      setHoldJustExpired(true);
      setSelectedIds(new Set());
      setHeldIds(new Set());
      setHoldExpiresAt(null);
      prevSelectedRef.current = new Set();
      reexecute({ requestPolicy: "network-only" });
    }
  }, [holdExpiresAt, holdSecondsLeft, reexecute]);

  useEffect(() => {
    const prev = prevSelectedRef.current;
    const current = selectedIds;

    const toHold = [...current].filter((id) => !prev.has(id));
    const toRelease = [...prev].filter((id) => !current.has(id));

    prevSelectedRef.current = new Set(current);

    if (toHold.length > 0) {
      startHoldTransition(async () => {
        const { data: holdData, error: holdErr } = await executeHoldSeats({ planId, seatIds: toHold });
        if (holdErr) {
          setHoldError(holdErr.message);
          reexecute({ requestPolicy: "network-only" });
          // Revert selection for seats that couldn't be held.
          setSelectedIds((prev) => {
            const next = new Set(prev);
            toHold.forEach((id) => next.delete(id));
            return next;
          });
        } else {
          setHeldIds((prev) => {
            const next = new Set(prev);
            (holdData?.holdSeats.held ?? []).forEach((id) => next.add(id));
            return next;
          });
          if (holdData?.holdSeats.expiresAt) setHoldExpiresAt(holdData.holdSeats.expiresAt);
          setHoldJustExpired(false);
          setHoldError(null);
        }
      });
    }

    if (toRelease.length > 0) {
      startHoldTransition(async () => {
        await executeReleaseSeats({ planId, seatIds: toRelease });
        setHeldIds((prev) => {
          const next = new Set(prev);
          toRelease.forEach((id) => next.delete(id));
          return next;
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  // ── grid building ─────────────────────────────────────────────────────────

  /** Build seat cells for the active section from the availability map. */
  const buildGrid = (): SeatCell[][] => {
    if (!activeSection) return [];

    const rows: SeatCell[][] = [];
    // Filter availability entries to only those belonging to the active section.
    const seatEntries = Object.entries(seatMap).filter(
      ([, entry]) => entry.sectionId === activeSection.id
    );

    // If active section is GA, rowCount may be 0 in data model; treat as single row.
    const isGA = activeSection.type === "ga";
    const rowCount = isGA ? 1 : activeSection.rowCount;
    const columnCount = isGA
      ? Math.max(1, seatEntries.length)
      : activeSection.columnCount;

    // Build rows × columnCount grid by index, filling seat IDs from filtered entries.
    const totalSeats = rowCount * columnCount;
    const relevantSeats = seatEntries.slice(0, totalSeats);

    for (let r = 0; r < rowCount; r++) {
      const row: SeatCell[] = [];
      for (let s = 0; s < columnCount; s++) {
        const idx = r * columnCount + s;
        if (idx >= relevantSeats.length) break;
        const [id, entry] = relevantSeats[idx] as [string, { status: SeatStatus; sectionId: string }];
        row.push({
          id,
          label: isGA ? `GA${idx + 1}` : `R${r + 1}S${s + 1}`,
          status: entry.status,
        });
      }
      if (row.length > 0) rows.push(row);
    }
    return rows;
  };

  const grid = buildGrid();

  // Build a flat seatId → label map for the sidebar display.
  const seatLabelMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    grid.forEach((row) => row.forEach((cell) => { map[cell.id] = cell.label; }));
    return map;
  }, [grid]);

  // Build sectionId → price string map from price tiers.
  const sectionPriceMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const section of sections) {
      if (section.priceTierId) {
        const tier = priceTiers.find((t) => t.id === section.priceTierId);
        if (tier) map[section.id] = tier.price;
      }
    }
    return map;
  }, [sections, priceTiers]);

  /** Price for a single seat in the active section (falls back to basePrice). */
  const activeSectionPrice = activeSection
    ? parseFloat(sectionPriceMap[activeSection.id] ?? basePrice)
    : parseFloat(basePrice);

  const selectedArray = [...selectedIds];
  // Total price: per-seat price from its section (look up sectionId via seat map).
  const totalPrice = selectedArray.reduce((sum, seatId) => {
    const sectionId = seatMap[seatId]?.sectionId;
    const price = sectionId
      ? parseFloat(sectionPriceMap[sectionId] ?? basePrice)
      : parseFloat(basePrice);
    return sum + price;
  }, 0);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 pb-24 lg:pb-0">
      {/* Section tabs as filter chip row */}
      {sections.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {sections.map((sec, idx) => {
            const isActive = idx === activeSectionIdx;
            const price = sectionPriceMap[sec.id];
            const label = `${sec.name} • ${sec.type.toUpperCase()}${price ? ` • $${parseFloat(price).toFixed(2)}` : ""}`;
            return (
              <button
                key={sec.id}
                onClick={() => setActiveSectionIdx(idx)}
                className={cn(
                  "px-3 py-1.5 rounded-sm text-xs font-medium border transition-colors",
                  isActive
                    ? "bg-accent text-accent-ink border-accent"
                    : "bg-subtle text-mute border-line hover:border-line/80"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Mode indicator (no toggle — determined by seller's plan) */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-mute">
          {isAutoAssignMode
            ? "Best available seats will be automatically selected for you."
            : "Click seats on the map to select them manually."}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        {/* Seat map */}
        <div className="flex flex-col gap-4">
          {/* Hold timer ribbon */}
          {holdExpiresAt && selectedArray.length > 0 && (
            <HoldTimerRibbon
              expiresAt={holdExpiresAt}
              tone="accent"
              onExpire={() => {
                // Trigger the existing hold-expiry handler
                setHoldJustExpired(true);
                setSelectedIds(new Set());
                setHeldIds(new Set());
                setHoldExpiresAt(null);
                prevSelectedRef.current = new Set();
                reexecute({ requestPolicy: "network-only" });
              }}
            />
          )}

          <Card className="p-6">
            {/* Legend */}
            <div className="flex flex-wrap gap-3 text-xs text-mute mb-4">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-subtle border border-line" />
                Available
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-warn-soft border border-warn" />
                On hold
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-line border border-line" />
                Sold
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-accent border border-accent" />
                Selected
              </span>
            </div>

            {loadError && (
              <div
                role="alert"
                className="flex items-start gap-2 text-sm text-bad bg-bad-soft border border-bad/20 rounded-md px-3 py-2.5 mb-4"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{loadError}</span>
                <button
                  onClick={() => reexecute({ requestPolicy: "network-only" })}
                  className="ml-auto shrink-0 text-bad hover:text-bad/80"
                  aria-label="Retry"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {holdError && (
              <div
                role="alert"
                className="flex items-start gap-2 text-sm text-bad bg-bad-soft border border-bad/20 rounded-md px-3 py-2.5 mb-4"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{holdError}</span>
              </div>
            )}

            {/* Stage indicator */}
            <div className="text-center py-2 mb-4">
              <div className="h-px bg-line mx-8 mb-1" />
              <p className="text-[10px] text-mute uppercase tracking-widest">Stage</p>
            </div>

            {/* Grid or loading state */}
            {!availData ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-accent" />
              </div>
            ) : grid.length === 0 ? (
              <p className="text-center text-sm text-mute py-8">
                No seats found for this section.
              </p>
            ) : (
              <SeatGrid
                seats={grid.flat().map((seat) => {
                  // Determine the displayed status:
                  // 1. If selected by current user → "selected"
                  // 2. If held by current user (server-side) → "selected" (they own it)
                  // 3. If held by someone else or sold → "held" or "sold"
                  // 4. Otherwise available
                  const isSelected = selectedIds.has(seat.id);
                  const isHeld = heldIds.has(seat.id);
                  const serverStatus = seatStatus(seat.id);

                  let displayStatus: "available" | "selected" | "held" | "sold" = "available";
                  if (isSelected || isHeld) {
                    displayStatus = "selected";
                  } else if (serverStatus === "held" || serverStatus === "reserved") {
                    displayStatus = "held";
                  } else if (serverStatus === "sold" || serverStatus === "blocked") {
                    displayStatus = "sold";
                  }

                  return {
                    id: seat.id,
                    ...parseSeatLabel(seat.label),
                    status: displayStatus,
                  };
                })}
                sectionLabel={activeSection?.name}
                onSelect={(seatId) => {
                  if (!isAutoAssignMode) {
                    toggleSeat(seatId);
                  }
                }}
                ariaLabel={`Seating map for ${activeSection?.name}`}
              />
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          {/* Selection summary / auto-assign panel */}
          {isAutoAssignMode ? (
            <Card>
              <CardContent className="pt-4">
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="font-semibold text-sm text-ink">Auto-assign seats</p>
                    <p className="text-xs text-mute mt-1">
                      We&apos;ll find the best available block of seats for you.
                    </p>
                  </div>

                  {autoState?.error && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 text-sm text-bad bg-bad-soft border border-bad/20 rounded-md px-3 py-2.5"
                    >
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{autoState.error}</span>
                    </div>
                  )}

                  <form action={autoFormAction} className="flex flex-col gap-3">
                    <input type="hidden" name="sectionId" value={activeSection?.id ?? ""} />

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="auto-quantity" className="text-xs font-medium text-mute uppercase tracking-wider">
                        Number of seats
                      </Label>
                      <Input
                        id="auto-quantity"
                        name="quantity"
                        type="number"
                        min={1}
                        max={plan.maxSeatsPerOrder}
                        value={autoQuantity}
                        onChange={(e) => {
                          const parsed = parseInt(e.target.value, 10) || 1;
                          setAutoQuantity(Math.min(Math.max(parsed, 1), plan.maxSeatsPerOrder));
                        }}
                      />
                      <p className="text-xs text-mute">
                        Up to {plan.maxSeatsPerOrder} per order
                      </p>
                    </div>

                    <div className="h-px bg-line" />
                    <div className="flex justify-between text-sm">
                      <span className="text-mute">Estimated total</span>
                      <span className="font-mono tabular-nums font-semibold text-ink">
                        ${(autoQuantity * activeSectionPrice).toFixed(2)}
                      </span>
                    </div>

                    <Button
                      type="submit"
                      variant="primary"
                      className="w-full gap-2"
                      disabled={autoPending || !activeSection}
                    >
                      {autoPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Reserving…
                        </>
                      ) : (
                        <>
                          <Shuffle className="w-4 h-4" />
                          Find Best Seats
                        </>
                      )}
                    </Button>
                  </form>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-4">
                <div className="flex flex-col gap-4">
                  <p className="font-semibold text-sm text-ink">
                    {selectedArray.length === 0
                      ? "No seats selected"
                      : `${selectedArray.length} seat${selectedArray.length > 1 ? "s" : ""} selected`}
                  </p>

                  {selectedArray.length >= plan.maxSeatsPerOrder && (
                    <p className="text-xs text-warn bg-warn-soft border border-warn/20 rounded-md px-3 py-2">
                      Max seats per order reached ({plan.maxSeatsPerOrder}).
                    </p>
                  )}

                  {holdJustExpired && (
                    <div
                      role="alert"
                      className="flex flex-col gap-2 text-sm text-bad bg-bad-soft border border-bad/20 rounded-md px-3 py-2.5"
                    >
                      <span>Your seat hold expired. Choose seats again to continue.</span>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => {
                            setHoldJustExpired(false);
                            reexecute({ requestPolicy: "network-only" });
                          }}
                        >
                          Refresh seats
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => setHoldJustExpired(false)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  )}

                  {selectedArray.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {selectedArray.map((id) => (
                        <li key={id} className="flex items-center justify-between text-xs">
                          <span className="font-mono tabular-nums text-mute">{seatLabelMap[id] ?? id.slice(0, 8) + "…"}</span>
                          <button
                            onClick={() => toggleSeat(id)}
                            className="text-mute hover:text-bad transition-colors"
                            aria-label={`Remove seat ${id}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {manualState?.error && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 text-sm text-bad bg-bad-soft border border-bad/20 rounded-md px-3 py-2.5"
                    >
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{manualState.error}</span>
                    </div>
                  )}

                  {selectedArray.length > 0 && (
                    <>
                      <div className="h-px bg-line" />
                      <div className="flex justify-between text-sm">
                        <span className="text-mute">Total</span>
                        <span className="font-mono tabular-nums font-semibold text-ink">
                          ${totalPrice.toFixed(2)}
                        </span>
                      </div>
                    </>
                  )}

                  <form action={manualFormAction}>
                    <input
                      type="hidden"
                      name="seatIds"
                      value={JSON.stringify(selectedArray)}
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      className="w-full gap-2"
                      disabled={manualPending || selectedArray.length === 0}
                    >
                      {manualPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Reserving…
                        </>
                      ) : (
                        <>
                          <CheckCircle className="w-4 h-4" />
                          Reserve {selectedArray.length > 0 ? `${selectedArray.length} Seat${selectedArray.length > 1 ? "s" : ""}` : "Seats"}
                        </>
                      )}
                    </Button>
                  </form>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Plan info */}
          <Card size="sm">
            <CardContent className="pt-3">
              <div className="flex flex-col gap-2">
                <p className="text-xs text-mute uppercase tracking-wider font-medium">Plan details</p>
                <div className="flex flex-col gap-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-mute">Max per order</span>
                    <span className="font-mono tabular-nums text-ink">{plan.maxSeatsPerOrder}</span>
                  </div>
                  {availData && (() => {
                    const counts = { available: 0, held: 0, sold: 0 };
                    for (const e of Object.values(seatMap)) {
                      if (e.status === "available") counts.available += 1;
                      else if (e.status === "held") counts.held += 1;
                      else if (e.status === "sold") counts.sold += 1;
                    }
                    return (
                      <>
                        <div className="flex justify-between">
                          <span className="text-mute">Available</span>
                          <span className="font-mono tabular-nums text-ok">{counts.available}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-mute">On hold</span>
                          <span className="font-mono tabular-nums text-warn">{counts.held}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-mute">Sold</span>
                          <span className="font-mono tabular-nums text-bad">{counts.sold}</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* View from seat placeholder */}
          {selectedArray.length === 1 && (
            <Card size="sm">
              <CardContent className="pt-3">
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-mute uppercase tracking-wider font-medium">View from seat</p>
                  <p className="text-xs text-mute">Coming soon</p>
                  <div className="text-sm font-mono tabular-nums text-ink bg-subtle rounded-sm p-2 text-center">
                    {(() => {
                      const singleId = selectedArray[0];
                      const label = seatLabelMap[singleId];
                      if (!label) return singleId.slice(0, 8);
                      // Format as "G·12"
                      const parsed = parseSeatLabel(label);
                      return parsed.row ? `${parsed.row}·${parsed.number}` : label;
                    })()}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          {isAutoAssignMode ? (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wider text-mute">Auto-assign</p>
                <p className="text-sm text-ink">
                  {autoQuantity} seat{autoQuantity > 1 ? "s" : ""} · ${(autoQuantity * activeSectionPrice).toFixed(2)}
                </p>
              </div>
              <form action={autoFormAction}>
                <input type="hidden" name="sectionId" value={activeSection?.id ?? ""} />
                <input type="hidden" name="quantity" value={String(autoQuantity)} />
                <Button type="submit" size="sm" disabled={autoPending || !activeSection}>
                  {autoPending ? "Reserving…" : "Find seats"}
                </Button>
              </form>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wider text-mute">Selected</p>
                <p className="text-sm text-ink">
                  {selectedArray.length} seat{selectedArray.length === 1 ? "" : "s"} · ${totalPrice.toFixed(2)}
                </p>
              </div>
              <form action={manualFormAction}>
                <input type="hidden" name="seatIds" value={JSON.stringify(selectedArray)} />
                <Button type="submit" size="sm" disabled={manualPending || selectedArray.length === 0}>
                  {manualPending ? "Reserving…" : "Reserve"}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
