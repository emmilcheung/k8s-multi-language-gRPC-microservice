import { cn } from "@/lib/utils";

type DividerProps = {
  orientation?: "horizontal" | "vertical";
  className?: string;
};

export function Divider({
  orientation = "horizontal",
  className,
}: DividerProps) {
  return (
    <div
      className={cn(
        "bg-line-soft",
        orientation === "horizontal" && "h-px w-full",
        orientation === "vertical" && "w-px h-full self-stretch",
        className
      )}
    />
  );
}
