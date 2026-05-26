import { cn } from "@/lib/utils";

type ADAGlyphProps = {
  className?: string;
  "aria-label"?: string;
};

export function ADAGlyph({ className, "aria-label": ariaLabel }: ADAGlyphProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={cn("size-4", className)}
      aria-hidden={!ariaLabel}
      aria-label={ariaLabel}
    >
      <circle cx="6.5" cy="2.5" r="1.4" fill="currentColor" />
      <path
        d="M5 5 L5 8.5 L8.5 8.5 L10.5 12 L12 11.4 L10 7 L7 7 L7 5.5 L5 5z"
        fill="currentColor"
      />
      <circle
        cx="7"
        cy="11"
        r="3.4"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}
