import Link from "next/link";
import { cn } from "@/lib/utils";

type EventPosterProps = {
  title: string;
  venue: string;
  date: string;
  priceFromCents: number;
  tag?: string;
  href?: string;
  className?: string;
};

export function EventPoster({
  title,
  venue,
  date,
  priceFromCents,
  tag,
  href,
  className,
}: EventPosterProps) {
  const formattedPrice = `$${(priceFromCents / 100).toFixed(2)}`;

  const card = (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-md border border-line bg-card p-4",
        "hover:border-mute transition-colors",
        className
      )}
    >
      {/* Gradient stripe */}
      <div className="h-16 rounded-sm bg-gradient-to-br from-accent/80 to-accent" />

      {/* Title */}
      <h3 className="font-semibold text-ink leading-tight line-clamp-2">
        {title}
      </h3>

      {/* Venue */}
      <p className="text-mute text-xs">{venue}</p>

      {/* Date row */}
      <p className="text-mute text-xs font-mono tabular-nums">{date}</p>

      {/* Price (bottom-right) */}
      <div className="flex justify-end">
        <span className="text-sm font-mono tabular-nums text-ink">
          {formattedPrice}
        </span>
      </div>

      {/* Tag (if provided) */}
      {tag && (
        <span className="text-[10px] uppercase tracking-wider text-accent bg-accent-soft px-1.5 py-0.5 rounded-sm">
          {tag}
        </span>
      )}
    </div>
  );

  if (href) {
    return <Link href={href}>{card}</Link>;
  }

  return card;
}
