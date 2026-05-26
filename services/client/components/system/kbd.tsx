import { cn } from "@/lib/utils";

type KbdProps = {
  children: React.ReactNode;
  className?: string;
};

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-sm",
        "border border-line bg-subtle text-mute text-[11px] font-mono",
        className
      )}
    >
      {children}
    </kbd>
  );
}
