"use client";
// components/seat-map-client.tsx — Interactive seat map for seated ticket checkout.
//
// Layout:
//  - Section tabs (if plan has multiple sections)
//  - Seat grid: colour-coded by status (available / held / reserved / sold / blocked)
//  - Selection sidebar: selected seats, total price, confirm / auto-assign CTA
//  - Auto-assign panel: section + quantity selector for best-available flow
//
// Holds are managed server-side via the holdSeats / releaseSeats Server Actions.
// The SSE stream (GET /api/seating-plans/:planId/events) refreshes the live seat
// map so the buyer always sees up-to-date availability.
//
// Security: userId is NEVER sent from this component — it is derived server-side
// from the Kong-injected X-User-Id header.

import { useState, useEffect, useCallback, useTransition, useRef, useMemo } from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  AlertCircle,
  CheckCircle,
  Shuffle,
  X,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SeatingPlan, AvailabilitySnapshot, SeatStatus, Section, PriceTier } from "@/lib/types";
import {
  holdSeats,
  releaseSeats,
  createManualSeatedOrder,
  createAutoAssignSeatedOrder,
} from "@/app/actions/orders";
import type { SeatedOrderState } from "@/app/actions/orders";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ─── helpers ──────────────────────────────────────────────────────────────────

const STATUS_CLASS: Record<SeatStatus, string> = {
  available: "bg-emerald-500/20 border-emerald-500/40 hover:bg-emerald-500/40 cursor-pointer",
  held: "bg-amber-500/20 border-amber-500/40 cursor-not-allowed opacity-60",
  reserved: "bg-blue-500/20 border-blue-500/40 cursor-not-allowed opacity-60",
  sold: "bg-red-500/20 border-red-500/40 cursor-not-allowed opacity-40",
  blocked: "bg-neutral-500/20 border-neutral-500/40 cursor-not-allowed opacity-40",
};

const STATUS_LABEL: Record<SeatStatus, string> = {
  available: "Available",
  held: "On hold",
  reserved: "Reserved",
  sold: "Sold",
  blocked: "Blocked",
};

const SELECTED_CLASS =
  "bg-primary/30 border-primary ring-2 ring-primary/60 cursor-pointer";

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
  initialAvailability: AvailabilitySnapshot | null;
  basePrice: string;
  priceTiers?: PriceTier[];
  /** From the seating plan: "manual" or "auto" */
  assignmentMode?: "manual" | "auto";
}

// ─── component ────────────────────────────────────────────────────────────────

const INITIAL_ORDER_STATE: SeatedOrderState = {};

export function SeatMapClient({ ticketId, planId, plan, initialAvailability, basePrice, priceTiers = [], assignmentMode = "manual" }: Props) {
  // Seat availability state.
  const [availability, setAvailability] = useState<AvailabilitySnapshot | null>(initialAvailability);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // Session ID — used by venue-service to correlate holds.
  const sessionIdRef = useRef<string>(
    typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  );

  // Hold action state.
  const [holdError, setHoldError] = useState<string | null>(null);
  const [, startHoldTransition] = useTransition();

  // Manual order action (bound below in JSX to avoid type issues with useActionState).
  const boundManual = createManualSeatedOrder.bind(null, ticketId, planId);
  const boundAutoAssign = createAutoAssignSeatedOrder.bind(null, ticketId, planId);
  const [manualState, manualFormAction, manualPending] = useActionState(boundManual, INITIAL_ORDER_STATE);
  const [autoState, autoFormAction, autoPending] = useActionState(boundAutoAssign, INITIAL_ORDER_STATE);

  // ── availability fetch & SSE ─────────────────────────────────────────────

  const fetchAvailability = useCallback(async () => {
    try {
      const kongUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
      const res = await fetch(`${kongUrl}/api/seating-plans/${planId}/availability`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json() as AvailabilitySnapshot;
      setAvailability(snap);
      setLoadError(null);
    } catch (err) {
      setLoadError("Could not load seat availability. Please refresh.");
      console.error("availability fetch failed", err);
    }
  }, [planId]);

  // Initial fetch if no server-side snapshot was available.
  useEffect(() => {
    if (!initialAvailability) {
      void fetchAvailability();
    }
  }, [initialAvailability, fetchAvailability]);

  // Safety-net polling in case SSE heartbeats/events are missed.
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchAvailability();
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchAvailability]);

  // Subscribe to SSE stream for live updates with exponential-backoff reconnection.
  useEffect(() => {
    const kongUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    let es: EventSource | null = null;
    let retryDelay = 1000; // ms — doubles on each failure, capped at 30s
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      es = new EventSource(`${kongUrl}/api/seating-plans/${planId}/events`);

      es.onmessage = () => {
        retryDelay = 1000; // reset backoff on successful message
        void fetchAvailability();
      };

      es.addEventListener("heartbeat", () => {
        retryDelay = 1000; // reset backoff on heartbeat
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (!unmounted) {
          retryTimer = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, 30_000);
            connect();
          }, retryDelay);
        }
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [planId, fetchAvailability]);

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
    return availability?.seatMap[seatId]?.status ?? "available";
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
      void fetchAvailability();
    }
  }, [holdExpiresAt, holdSecondsLeft, fetchAvailability]);

  useEffect(() => {
    const prev = prevSelectedRef.current;
    const current = selectedIds;

    const toHold = [...current].filter((id) => !prev.has(id));
    const toRelease = [...prev].filter((id) => !current.has(id));

    prevSelectedRef.current = new Set(current);

    if (toHold.length > 0) {
      startHoldTransition(async () => {
        const result = await holdSeats(planId, toHold, sessionIdRef.current);
        if (result.error) {
          setHoldError(result.error);
          void fetchAvailability();
          // Revert selection for seats that couldn't be held.
          setSelectedIds((prev) => {
            const next = new Set(prev);
            toHold.forEach((id) => next.delete(id));
            return next;
          });
        } else {
          setHeldIds((prev) => {
            const next = new Set(prev);
            (result.held ?? []).forEach((id) => next.add(id));
            return next;
          });
          if (result.expiresAt) setHoldExpiresAt(result.expiresAt);
          setHoldJustExpired(false);
          setHoldError(null);
        }
      });
    }

    if (toRelease.length > 0) {
      startHoldTransition(async () => {
        await releaseSeats(planId, toRelease);
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
    const seatEntries = Object.entries(availability?.seatMap ?? {}).filter(
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
        const [id, entry] = relevantSeats[idx];
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
  // Total price: per-seat price from its section (look up sectionId via availability map).
  const totalPrice = selectedArray.reduce((sum, seatId) => {
    const sectionId = availability?.seatMap[seatId]?.sectionId;
    const price = sectionId
      ? parseFloat(sectionPriceMap[sectionId] ?? basePrice)
      : parseFloat(basePrice);
    return sum + price;
  }, 0);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* Section tabs */}
      {sections.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {sections.map((sec, idx) => (
            <button
              key={sec.id}
              onClick={() => setActiveSectionIdx(idx)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors",
                idx === activeSectionIdx
                  ? "bg-primary/20 border-primary/40 text-primary"
                  : "border-white/10 text-muted-foreground hover:border-white/20"
              )}
            >
              {sec.name}
              <span className="ml-1.5 text-xs opacity-60">{sec.type.toUpperCase()}</span>
              {sectionPriceMap[sec.id] && (
                <span className="ml-1 text-xs opacity-80">${parseFloat(sectionPriceMap[sec.id]).toFixed(2)}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Mode indicator (no toggle — determined by seller's plan) */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isAutoAssignMode
            ? "Best available seats will be automatically selected for you."
            : "Click seats on the map to select them manually."}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        {/* Seat map */}
        <div className="glass rounded-2xl p-6 flex flex-col gap-4">
          {/* Legend */}
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {(["available", "held", "sold", "blocked"] as SeatStatus[]).map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "w-3 h-3 rounded-sm border",
                    STATUS_CLASS[s].split(" ").slice(0, 2).join(" ")
                  )}
                />
                {STATUS_LABEL[s]}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm border bg-primary/30 border-primary" />
              Selected
            </span>
          </div>

          {loadError && (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{loadError}</span>
              <button
                onClick={fetchAvailability}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Retry"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {holdError && (
            <div
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{holdError}</span>
            </div>
          )}

          {/* Stage indicator */}
          <div className="text-center py-1">
            <div className="h-2 rounded-sm bg-white/6 mx-8 mb-1" />
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Stage</p>
          </div>

          {/* Grid */}
          {!availability ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : grid.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              No seats found for this section.
            </p>
          ) : (
            <div
              className="grid gap-1 overflow-auto"
              style={{
                gridTemplateColumns: `repeat(${
                  activeSection?.type === "ga"
                    ? Math.max(1, grid[0]?.length ?? 1)
                    : activeSection?.columnCount ?? 10
                }, minmax(28px, 1fr))`,
              }}
            >
              {grid.flat().map((seat) => {
                const isSelected = selectedIds.has(seat.id);
                const status = seatStatus(seat.id);
                return (
                  <button
                    key={seat.id}
                    title={`${seat.label} — ${STATUS_LABEL[status]}`}
                    aria-pressed={isSelected}
                    aria-label={`Seat ${seat.label} ${STATUS_LABEL[status]}`}
                    disabled={
                      !isSeatSelectable(seat.id) ||
                      isAutoAssignMode ||
                      (!isSelected && selectedArray.length >= plan.maxSeatsPerOrder)
                    }
                    onClick={() => toggleSeat(seat.id)}
                    className={cn(
                      "h-7 w-full rounded-sm border text-[9px] font-mono transition-colors",
                      isSelected ? SELECTED_CLASS : STATUS_CLASS[status]
                    )}
                  >
                    {seat.label.replace("R", "").replace("S", "")}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          {/* Selection summary / auto-assign panel */}
          {isAutoAssignMode ? (
            <div className="glass rounded-2xl p-6 flex flex-col gap-4">
              <p className="font-semibold text-sm">Auto-assign seats</p>
              <p className="text-xs text-muted-foreground">
                We&apos;ll find the best available block of seats for you.
              </p>

              {autoState?.error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{autoState.error}</span>
                </div>
              )}

              <form action={autoFormAction} className="flex flex-col gap-3">
                <input type="hidden" name="sectionId" value={activeSection?.id ?? ""} />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="auto-quantity" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
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
                  <p className="text-xs text-muted-foreground">
                    Up to {plan.maxSeatsPerOrder} per order
                  </p>
                </div>

                <div className="h-px bg-white/6" />
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Estimated total</span>
                  <span className="font-bold gradient-text">
                    ${(autoQuantity * activeSectionPrice).toFixed(2)}
                  </span>
                </div>

                <Button
                  type="submit"
                  className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
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
          ) : (
            <div className="glass rounded-2xl p-6 flex flex-col gap-4">
              <p className="font-semibold text-sm">
                {selectedArray.length === 0
                  ? "No seats selected"
                  : `${selectedArray.length} seat${selectedArray.length > 1 ? "s" : ""} selected`}
              </p>

              {selectedArray.length >= plan.maxSeatsPerOrder && (
                <p className="text-xs text-amber-400/90">
                  Max seats per order reached ({plan.maxSeatsPerOrder}).
                </p>
              )}

              {holdJustExpired && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
                >
                  <span>Your seat hold expired. Choose seats again to continue.</span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setHoldJustExpired(false);
                        void fetchAvailability();
                      }}
                    >
                      Refresh seats
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setHoldJustExpired(false)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}

              {holdExpiresAt && selectedArray.length > 0 && holdSecondsLeft !== null && (
                <Badge className={`text-xs w-fit border ${
                  holdSecondsLeft <= 30
                    ? "bg-red-500/15 text-red-400 border-red-500/30"
                    : "bg-amber-500/15 text-amber-400 border-amber-500/30"
                }`}>
                  Hold expires in {holdSecondsLeft}s
                </Badge>
              )}

              {selectedArray.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {selectedArray.map((id) => (
                    <li key={id} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-muted-foreground">{seatLabelMap[id] ?? id.slice(0, 8) + "…"}</span>
                      <button
                        onClick={() => toggleSeat(id)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
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
                  className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{manualState.error}</span>
                </div>
              )}

              {selectedArray.length > 0 && (
                <>
                  <div className="h-px bg-white/6" />
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Total</span>
                    <span className="font-bold gradient-text">
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
                  className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
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
          )}

          {/* Plan info */}
          <div className="glass rounded-2xl p-4 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Plan details</p>
            <div className="flex flex-col gap-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Max per order</span>
                <span>{plan.maxSeatsPerOrder}</span>
              </div>
              {availability && (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Available</span>
                    <span className="text-emerald-400">{availability.counts.available}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">On hold</span>
                    <span className="text-amber-400">{availability.counts.held}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sold</span>
                    <span className="text-red-400">{availability.counts.sold}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
