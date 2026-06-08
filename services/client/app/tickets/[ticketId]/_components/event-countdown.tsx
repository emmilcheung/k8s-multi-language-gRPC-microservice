"use client";
// Event countdown component — displays time until event starts (e.g., "Doors open in 3d 14h")

import { useEffect, useState } from "react";

interface EventCountdownProps {
  startsAt: string;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return "Event started";
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return `Doors open in ${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `Doors open in ${hours}h ${remainingMinutes}m`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `Doors open in ${minutes}m ${remainingSeconds}s`;
  }

  return `Doors open in ${seconds}s`;
}

export function EventCountdown({ startsAt }: EventCountdownProps) {
  const [display, setDisplay] = useState<string>("");

  useEffect(() => {
    const update = () => {
      const startDate = new Date(startsAt);
      const now = new Date();
      const ms = startDate.getTime() - now.getTime();
      setDisplay(formatCountdown(ms));
    };

    update();
    const interval = setInterval(update, 60000); // Update every 60 seconds

    return () => clearInterval(interval);
  }, [startsAt]);

  if (!display) {
    return null;
  }

  return (
    <div className="font-mono tabular-nums text-xs text-mute">
      {display}
    </div>
  );
}
