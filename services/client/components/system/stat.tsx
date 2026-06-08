import { cn } from "@/lib/utils";

type StatProps = {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  align?: "start" | "end";
  className?: string;
};

export function Stat({
  label,
  value,
  sub,
  align = "start",
  className,
}: StatProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        align === "end" && "items-end",
        align === "start" && "items-start",
        className
      )}
    >
      <span className="text-mute text-[10px] uppercase tracking-[0.08em] font-medium">
        {label}
      </span>
      <span className="text-ink text-2xl font-mono tabular-nums font-medium">
        {value}
      </span>
      {sub && <span className="text-mute text-xs">{sub}</span>}
    </div>
  );
}
