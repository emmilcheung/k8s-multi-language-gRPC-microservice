import { cn } from "@/lib/utils";
import { ADAGlyph } from "./ada-glyph";

export type SeatStatus = "available" | "selected" | "held" | "sold";

export type SeatGridSeat = {
  id: string;
  row: string;
  number: number;
  status: SeatStatus;
  accessible?: boolean;
  priceCents?: number;
};

export type SeatGridProps = {
  seats: SeatGridSeat[];
  sectionLabel?: string;
  onSelect?: (seatId: string) => void;
  ariaLabel?: string;
  className?: string;
};

export function SeatGrid({
  seats,
  sectionLabel,
  onSelect,
  ariaLabel,
  className,
}: SeatGridProps) {
  // Group seats by row
  const rowMap = new Map<string, SeatGridSeat[]>();
  seats.forEach((seat) => {
    if (!rowMap.has(seat.row)) {
      rowMap.set(seat.row, []);
    }
    rowMap.get(seat.row)!.push(seat);
  });

  // Sort rows alphabetically and seats by number
  const sortedRows = Array.from(rowMap.keys()).sort();
  const rows = sortedRows.map((row) => ({
    row,
    seats: rowMap.get(row)!.sort((a, b) => a.number - b.number),
  }));

  const getStatusClasses = (status: SeatStatus) => {
    switch (status) {
      case "available":
        return "bg-subtle text-ink hover:bg-accent/20 cursor-pointer";
      case "selected":
        return "bg-accent text-accent-ink hover:bg-accent/90 cursor-pointer";
      case "held":
        return "bg-warn-soft text-warn cursor-not-allowed";
      case "sold":
        return "bg-line text-fade cursor-not-allowed";
    }
  };

  const handleSeatClick = (seat: SeatGridSeat) => {
    if (!onSelect) return;
    if (seat.status === "available" || seat.status === "selected") {
      onSelect(seat.id);
    }
  };

  return (
    <div
      className={cn("flex flex-col", className)}
      role="grid"
      aria-label={ariaLabel ?? sectionLabel ?? "Seat grid"}
    >
      {sectionLabel && (
        <div className="text-xs uppercase tracking-wider text-mute font-medium mb-3">
          {sectionLabel}
        </div>
      )}

      <div className="overflow-x-auto">
        <div className="flex flex-col gap-1.5 min-w-max">
          {rows.map(({ row, seats: rowSeats }) => (
            <div key={row} className="flex items-center gap-1">
              <span className="w-6 text-xs text-mute font-mono tabular-nums text-right">
                {row}
              </span>
              <div className="flex gap-1">
                {rowSeats.map((seat) => (
                  <button
                    key={seat.id}
                    onClick={() => handleSeatClick(seat)}
                    disabled={seat.status === "held" || seat.status === "sold"}
                    className={cn(
                      "inline-flex items-center justify-center size-7 rounded-sm text-[10px] font-mono tabular-nums transition-colors relative",
                      getStatusClasses(seat.status)
                    )}
                    aria-label={`Seat ${row}·${seat.number}${seat.accessible ? " accessible" : ""}, ${seat.status}`}
                    aria-pressed={
                      seat.status === "available" || seat.status === "selected"
                        ? seat.status === "selected"
                        : undefined
                    }
                  >
                    {seat.number}
                    {seat.accessible && (
                      <ADAGlyph
                        className="size-2.5 absolute -top-0.5 -right-0.5 text-accent"
                        aria-hidden
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
