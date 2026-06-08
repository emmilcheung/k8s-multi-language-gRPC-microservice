"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type HoldTimerRibbonProps = {
  expiresAt: string;
  tone?: "accent" | "warn";
  onExpire?: () => void;
  className?: string;
};

// Pre-compute initial remaining outside component to avoid calling Date.now during render
function computeInitialRemaining(expiresAt: string): number {
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

export function HoldTimerRibbon({
  expiresAt,
  tone = "accent",
  onExpire,
  className,
}: HoldTimerRibbonProps) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [hasExpired, setHasExpired] = useState(false);
  const [onExpireCalled, setOnExpireCalled] = useState(false);

  // Initialize remaining time on mount
  useEffect(() => {
    setRemaining(computeInitialRemaining(expiresAt));
  }, [expiresAt]);

  // Tick every second
  useEffect(() => {
    if (remaining === null) return;
    if (hasExpired) return;

    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev === null || prev <= 0) {
          setHasExpired(true);
          return 0;
        }
        return Math.max(0, prev - 1000);
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [remaining, hasExpired]);

  // Call onExpire exactly once when we hit 0
  useEffect(() => {
    if (hasExpired && !onExpireCalled && onExpire) {
      setOnExpireCalled(true);
      onExpire();
    }
  }, [hasExpired, onExpireCalled, onExpire]);

  // Avoid hydration mismatch
  if (remaining === null) {
    const initial = computeInitialRemaining(expiresAt);
    const minutes = Math.floor(initial / 1000 / 60);
    const seconds = Math.floor((initial / 1000) % 60);
    const display = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    return (
      <div
        className={cn(
          "flex items-center justify-between gap-4 px-4 py-2.5 rounded-md",
          "bg-accent-soft text-accent",
          className
        )}
      >
        <span className="text-xs uppercase tracking-wider">Holding seats</span>
        <span className="font-mono tabular-nums text-base font-medium">
          {display}
        </span>
      </div>
    );
  }

  const minutes = Math.floor(remaining / 1000 / 60);
  const seconds = Math.floor((remaining / 1000) % 60);
  const display = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  // Determine tone: auto-escalate to "warn" when < 2 min
  const effectiveTone = remaining < 120_000 ? "warn" : tone;
  const bgClass = effectiveTone === "warn" ? "bg-warn-soft" : "bg-accent-soft";
  const textClass = effectiveTone === "warn" ? "text-warn" : "text-accent";

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-2.5 rounded-md",
        bgClass,
        textClass,
        className
      )}
    >
      <span className="text-xs uppercase tracking-wider">Holding seats</span>
      <span className="font-mono tabular-nums text-base font-medium">
        {display}
      </span>
    </div>
  );
}
