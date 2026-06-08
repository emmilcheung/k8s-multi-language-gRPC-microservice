// app/orders/loading.tsx — Suspense skeleton for the My Orders list page.

import { Skeleton } from "@/components/ui/skeleton";

export default function OrdersLoading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 py-2">
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-48" />
      </div>

      <div className="grid gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-md border border-line bg-card p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-8 w-20" />
            <Skeleton className="mt-2 h-3 w-28" />
          </div>
        ))}
      </div>

      <div className="flex gap-4 border-b border-line">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="mb-3 h-6 w-20" />
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="overflow-hidden rounded-md border border-line bg-card">
            <Skeleton className="h-24 w-full md:hidden" />
            <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <Skeleton className="h-5 w-56" />
                <div className="flex flex-wrap gap-3">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-4 w-32" />
                </div>
              </div>
              <div className="space-y-3">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-8 w-32" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
