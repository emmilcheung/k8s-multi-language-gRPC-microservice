// app/tickets/[ticketId]/loading.tsx — Suspense skeleton for ticket detail page.

import { Skeleton } from "@/components/ui/skeleton";

export default function TicketDetailLoading() {
  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto">
      <Skeleton className="h-8 w-28" />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Info panel */}
        <div className="glass rounded-2xl p-8 flex flex-col gap-6">
          <div className="flex items-start justify-between gap-4">
            <Skeleton className="size-14 rounded-2xl" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-9 w-3/4" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-36" />
          </div>
          <Skeleton className="h-8 w-24" />
          <div className="flex gap-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>

        {/* Action panel */}
        <div className="glass rounded-2xl p-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-32" />
          </div>
          <Skeleton className="h-px w-full" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-3 w-40 mx-auto" />
        </div>
      </div>
    </div>
  );
}
